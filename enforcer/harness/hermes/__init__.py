"""Enforcer for Hermes Agent: telemetry to Enforcer governance, on by default.

register(ctx) wires Hermes' observer hooks to an OTLP logs + metrics exporter
(service.name=hermes, every name under hermes.*), adds `hermes enforcer ...`
and `/enforcer`, and points the user at the Enforcer MCP server. It never
blocks the agent loop: hooks enqueue, a daemon thread exports, and any failure
is counted, logged once, and dropped.

Turn telemetry off with
    hermes config set plugins.entries.enforcer.settings.telemetry false
or ENFORCER_TELEMETRY=0, or disable the plugin.
"""

from __future__ import annotations

import atexit
import json
import logging
import platform
import time
from typing import Any, Optional

from . import events, exporter, settings

logger = logging.getLogger(__name__)

def _manifest_version() -> str:
    """plugin.yaml's version. The Hermes plugin is versioned on its own: the
    release bump moves the JSON manifests of the enforcer package, and a Hermes
    install is a sparse clone of this directory only."""
    import re
    from pathlib import Path

    try:
        m = re.search(r'^version:\s*"?([^"\s]+)', (Path(__file__).parent / "plugin.yaml").read_text(encoding="utf-8"), re.M)
        return m.group(1) if m else ""
    except Exception:
        return ""


PLUGIN_VERSION = _manifest_version()
MCP_NAME = "enforcer"

_state: dict[str, Any] = {}


def _setting(ctx: Any, key: str, default: Any = None) -> Any:
    try:
        v = ctx.get_config(key, default)
        return default if v is None else v
    except Exception:
        return default


def _hermes_version() -> str:
    try:
        from importlib.metadata import version

        return version("hermes-agent")
    except Exception:
        return ""


def resource_attributes() -> dict[str, Any]:
    return {
        "service.name": "hermes",
        "service.version": _hermes_version() or None,
        "enforcer.harness": settings.HARNESS,
        "enforcer.plugin.version": PLUGIN_VERSION or None,
        "os.type": platform.system().lower() or None,
    }


def build(ctx: Any, *, poster: Optional[exporter.Poster] = None, key_source=None) -> Optional[exporter.Exporter]:
    """The exporter this ctx's settings ask for, or None when telemetry is off."""
    if not settings.telemetry_enabled(_setting(ctx, "telemetry", True)):
        return None
    origin = settings.base_url(str(_setting(ctx, "base_url", "") or ""))
    cli = str(_setting(ctx, "enforcer_cli", "") or "")
    kw: dict[str, Any] = {
        "max_queue": int(_setting(ctx, "max_queue", 2048) or 2048),
        "batch_size": int(_setting(ctx, "batch_size", 256) or 256),
        "interval": float(_setting(ctx, "flush_interval_s", 5.0) or 5.0),
    }
    if poster is not None:
        kw["poster"] = poster
    return exporter.Exporter(resource_attributes(), origin, key_source or (lambda: settings.fetch_key(cli)), **kw)


def _mcp_configured() -> Optional[bool]:
    try:
        from hermes_cli.config import load_config_readonly  # public plugin surface

        servers = (load_config_readonly() or {}).get("mcp_servers") or {}
        return MCP_NAME in servers
    except Exception:
        return None


def mcp_command(origin: str) -> str:
    return f"hermes mcp add {MCP_NAME} --url {origin}/mcp --auth oauth"


def status(ctx: Any) -> dict[str, Any]:
    exp: Optional[exporter.Exporter] = _state.get("exporter")
    origin = settings.base_url(str(_setting(ctx, "base_url", "") or ""))
    out: dict[str, Any] = {
        "telemetry": "on" if exp is not None else "off",
        "origin": origin,
        "mcp": {"configured": _mcp_configured(), "add_with": mcp_command(origin)},
        "turn_off": "hermes config set plugins.entries.enforcer.settings.telemetry false",
    }
    if exp is not None:
        s = exp.stats
        out.update({
            "endpoints": s.endpoints or {sig: settings.otlp_endpoint(origin, sig) for sig in ("logs", "metrics")},
            "key": {
                "source": s.key_source or None,
                "credential_id": s.credential_id or None,
                "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(s.key_expires_at)) if s.key_expires_at else None,
                "error": s.key_error or None,
            },
            "exported": {"logs": s.exported_logs, "metric_points": s.exported_points},
            "dropped": {"queue_full": s.dropped_queue_full, "no_key": s.dropped_no_key, "export_failed": s.dropped_export},
            "last_status": s.last_status,
            "last_error": s.last_error or None,
        })
    return out


def _cli_setup(parser: Any) -> None:
    sub = parser.add_subparsers(dest="enforcer_cmd")
    sub.add_parser("status", help="Show where Hermes telemetry goes and how it is doing")
    sub.add_parser("mcp", help="Print the command that adds the Enforcer MCP server to Hermes")
    t = sub.add_parser("telemetry", help="Turn telemetry to Enforcer governance on or off")
    t.add_argument("state", choices=["on", "off"])


def _cli_handler(ctx: Any):
    def handle(args: Any) -> None:
        cmd = getattr(args, "enforcer_cmd", None) or "status"
        if cmd == "telemetry":
            ctx.set_config("telemetry", args.state == "on")
            print(f"Enforcer telemetry {args.state} (takes effect in the next Hermes session).")
        elif cmd == "mcp":
            origin = settings.base_url(str(_setting(ctx, "base_url", "") or ""))
            configured = _mcp_configured()
            if configured:
                print(f"mcp_servers.{MCP_NAME} is already configured.")
            else:
                print("Add the Enforcer MCP server (OAuth sign-in on first use):\n  " + mcp_command(origin))
        else:
            print(json.dumps(status(ctx), indent=2))

    return handle


def _hook(fn):
    """Observer hooks must never raise into Hermes (it would only log, but a
    warning per tool call is noise). Return None: observers have no say."""

    def call(**kw: Any) -> None:
        try:
            fn(**kw)
        except Exception as e:  # pragma: no cover - fail open
            logger.debug("enforcer: %s hook failed: %s", getattr(fn, "__name__", "?"), e)
        return None

    return call


def register(ctx: Any) -> None:
    exp = build(ctx)
    _state["exporter"] = exp
    if exp is not None:
        mapper = events.Mapper(exp.emit_log, exp.emit_point, exp.flush_soon)
        for name in events.HOOKS:
            ctx.register_hook(name, _hook(getattr(mapper, name)))
        atexit.register(exp.shutdown)
    else:
        logger.info("enforcer: Hermes telemetry is off (plugins.entries.enforcer.settings.telemetry or ENFORCER_TELEMETRY)")

    register_cli = getattr(ctx, "register_cli_command", None)
    if register_cli is not None:
        register_cli(
            name="enforcer",
            help="Enforcer: telemetry status, on/off, and the MCP server",
            setup_fn=_cli_setup,
            handler_fn=_cli_handler(ctx),
        )
    register_command = getattr(ctx, "register_command", None)
    if register_command is not None:
        register_command("enforcer", lambda raw="": json.dumps(status(ctx), indent=2), description="Enforcer telemetry status")
