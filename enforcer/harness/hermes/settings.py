"""Where telemetry goes and the key it goes with.

The key is never minted here. `enforcer ingest-key --harness hermes --json`
(agent-plugins, enforcer/src/ingest-key.mjs) owns provisioning: it creates or
rotates a telemetry-only credential for this machine and caches it 0600 in
~/.enforcer/ingest-keys.json. This module only runs it and reads its answer.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

HARNESS = "hermes"
DEFAULT_BASE_URL = "https://api.instruxi.dev"
OTLP_PATH = "/api/v1/governance/otlp"
KEY_HEADER = "X-API-Key"
CLI_TIMEOUT_S = 30.0
# Re-run the CLI this long before the key expires. The CLI itself rotates a
# key with under 7 days left; this only keeps a long-lived Hermes process from
# holding a key past its expiry.
REFRESH_BEFORE_S = 3600.0

_OFF = {"0", "false", "no", "off"}


def enforcer_home() -> Path:
    return Path(os.environ.get("ENFORCER_HOME") or Path.home() / ".enforcer")


def _saved_base_url() -> str:
    try:
        data = json.loads((enforcer_home() / "credentials.json").read_text(encoding="utf-8"))
        url = (data.get("enforcer") or {}).get("base_url") or ""
        return url if isinstance(url, str) else ""
    except Exception:
        return ""


def _origin(url: str) -> str:
    u = urlsplit(url.strip())
    if u.scheme not in ("http", "https") or not u.netloc:
        return ""
    return f"{u.scheme}://{u.netloc}"


def base_url(setting: str = "") -> str:
    """The Enforcer origin, in the precedence enforcer/src/config.mjs uses:
    the plugin setting, ENFORCER_BASE_URL, the signed-in base_url, production."""
    for candidate in (setting, os.environ.get("ENFORCER_BASE_URL", ""), _saved_base_url()):
        origin = _origin(candidate or "")
        if origin:
            return origin
    return DEFAULT_BASE_URL


def otlp_endpoint(origin: str, signal: str, otlp_base: str = "") -> str:
    """<origin>/api/v1/governance/otlp/v1/<logs|metrics>, or <otlpBase>/v1/<signal>
    when the CLI named the base. Governance has no traces endpoint, so only
    these two are ever built."""
    if signal not in ("logs", "metrics"):
        raise ValueError(f"governance accepts logs and metrics, not {signal}")
    base = otlp_base.rstrip("/") if _origin(otlp_base) else f"{origin}{OTLP_PATH}"
    return f"{base}/v1/{signal}"


def telemetry_enabled(setting: Any) -> bool:
    """On unless the setting or ENFORCER_TELEMETRY turns it off."""
    env = os.environ.get("ENFORCER_TELEMETRY")
    if env is not None and env.strip().lower() in _OFF:
        return False
    if isinstance(setting, bool):
        return setting
    if isinstance(setting, str) and setting.strip().lower() in _OFF:
        return False
    return True


def find_cli(setting: str = "") -> Optional[list[str]]:
    """The argv prefix that runs the `enforcer` CLI, or None.

    The plugin setting or ENFORCER_CLI first, then `enforcer` on PATH, then
    the copy Claude Code installed: ~/.enforcer/plugin-root names a directory
    inside the enforcer plugin, and bin/enforcer sits at that plugin's root.
    """
    explicit = setting or os.environ.get("ENFORCER_CLI", "")
    if explicit:
        return explicit.split() if " " in explicit and not Path(explicit).exists() else [explicit]
    on_path = shutil.which("enforcer")
    if on_path:
        return [on_path]
    try:
        root = Path((enforcer_home() / "plugin-root").read_text(encoding="utf-8").strip())
    except Exception:
        return None
    node = shutil.which("node")
    for d in (root, *root.parents):
        script = d / "bin" / "enforcer"
        if script.is_file():
            return [node, str(script)] if node else None
        if d == Path.home():
            break
    return None


@dataclass
class IngestKey:
    key: str
    credential_id: str = ""
    agent_id: str = ""
    expires_at: float = 0.0  # epoch seconds; 0 when the CLI gave none
    source: str = "cli"  # the CLI's own: cache | minted | rotated; "env" for ENFORCER_INGEST_KEY
    otlp_base: str = ""  # <origin>/api/v1/governance/otlp, when the CLI names it

    def fresh(self, now: float) -> bool:
        return not self.expires_at or self.expires_at - now > REFRESH_BEFORE_S


def _epoch(v: Any) -> float:
    if isinstance(v, (int, float)):
        return float(v) / 1000.0 if v > 1e12 else float(v)
    if isinstance(v, str) and v:
        from datetime import datetime

        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


class KeyError_(RuntimeError):
    """No key: the CLI is missing, signed out, or failed. The message is safe to show."""

    def __init__(self, message: str, code: int = -1):
        super().__init__(message)
        self.code = code


# enforcer ingest-key exit codes (agent-plugins enforcer/src/ingest-key.mjs).
_EXIT = {
    1: "enforcer ingest-key failed",
    2: "enforcer ingest-key usage error",
    3: "signed out of Enforcer (run /enforcer:login, or `enforcer login`)",
    4: "the Hermes agent for this machine is disabled in the Enforcer console",
}


Runner = Callable[[list[str], float], "subprocess.CompletedProcess[str]"]


def _run(argv: list[str], timeout: float) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, check=False)


def fetch_key(cli_setting: str = "", runner: Runner = _run) -> IngestKey:
    """Ask the CLI for this machine's Hermes ingest key.

    ENFORCER_INGEST_KEY short-circuits it, for containers and CI that are
    handed a key instead of a signed-in CLI.
    """
    env_key = os.environ.get("ENFORCER_INGEST_KEY", "").strip()
    if env_key:
        return IngestKey(key=env_key, source="env")
    cli = find_cli(cli_setting)
    if not cli:
        raise KeyError_("the enforcer CLI was not found (install the Enforcer plugin, or set ENFORCER_CLI)")
    try:
        r = runner([*cli, "ingest-key", "--harness", HARNESS, "--json"], CLI_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise KeyError_("enforcer ingest-key timed out") from None
    except OSError as e:
        raise KeyError_(f"enforcer ingest-key could not start: {e.strerror or e}") from None
    if r.returncode != 0:
        # stderr is the CLI's own message; never the key.
        msg = (r.stderr or "").strip().splitlines()
        why = _EXIT.get(r.returncode, f"enforcer ingest-key exited {r.returncode}")
        raise KeyError_(why + (f": {msg[-1][:200]}" if msg else ""), r.returncode)
    try:
        data = json.loads(r.stdout)
    except ValueError:
        raise KeyError_("enforcer ingest-key did not print JSON") from None
    key = data.get("key") if isinstance(data, dict) else None
    if not isinstance(key, str) or not key:
        raise KeyError_("enforcer ingest-key printed no key")
    return IngestKey(
        key=key,
        credential_id=str(data.get("credentialId") or ""),
        agent_id=str(data.get("agentId") or ""),
        expires_at=_epoch(data.get("expiresAt")),
        source=str(data.get("source") or "cli"),
        otlp_base=str(data.get("otlpBase") or ""),
    )


def now() -> float:
    return time.time()
