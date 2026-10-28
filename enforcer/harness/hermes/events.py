"""Hermes observer hooks -> `hermes.*` OTLP log records and metric points.

What is sent is metadata only: names, ids, counts, durations, statuses, token
counts and cost. Prompts, responses, tool arguments, tool results, sub-agent
goals and summaries, approval commands and provider error messages are never
read into a record (Hermes hands them to the hooks; this module drops them).

Every record carries `session.id`, the key governance's `hermes` provenance
profile and spend rollups read, and `hermes.session_id`, the id Hermes itself
uses. They differ on purpose: governance files a session under the first 8
characters of session.id (migration 016), and Hermes ids are
`YYYYMMDD_HHMMSS_<hex6>`, `local-<sha256>`, `cron_<job>_<stamp>`, `api_<epoch>_..`:
their first 8 characters are a date or a fixed prefix, so every session of a
day (or every TUI session) would land in one governance session. session.id is
therefore the UUIDv5 of the Hermes id: stable, random in its first 8 characters
like Claude Code's session UUIDs, and recomputable from hermes.session_id.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Callable, Mapping, Optional

from . import otlp

SESSION = "session.id"
RAW_SESSION = "hermes.session_id"
# uuid5(NAMESPACE_URL, "https://instruxi.dev/enforcer/hermes/session"): fixed forever, so
# governance and anyone else can recompute session.id from hermes.session_id.
SESSION_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://instruxi.dev/enforcer/hermes/session")


def session_uuid(hermes_session_id: str) -> str:
    """The session.id governance sees for a Hermes session id ("" stays "")."""
    return str(uuid.uuid5(SESSION_NAMESPACE, hermes_session_id)) if hermes_session_id else ""
# Prices Hermes itself reports as real money (hermes_otel uses the same set).
PRICED = {"actual", "estimated"}

# Token buckets of Hermes' CanonicalUsage (agent/usage_pricing.py) -> the `type`
# values of hermes.token.usage. CanonicalUsage is already split the way
# Anthropic splits it: input_tokens EXCLUDES cache reads and writes, and
# output_tokens INCLUDES reasoning. So input/output/cache_read/cache_creation
# are disjoint and sum to the call's total; reasoning is a subset of output
# and is sent for visibility only (governance does not add it to a total).
TOKEN_TYPES = (
    ("input_tokens", "input"),
    ("output_tokens", "output"),
    ("cache_read_tokens", "cache_read"),
    ("cache_write_tokens", "cache_creation"),
    ("reasoning_tokens", "reasoning"),
)

Emit = Callable[[dict], None]
Pricer = Callable[[str, str, str, Mapping[str, Any]], Optional[tuple[str, Optional[float]]]]


def _now_ns() -> int:
    return time.time_ns()


def _int(v: Any) -> int:
    try:
        return max(0, int(v or 0))
    except (TypeError, ValueError):
        return 0


def _str(v: Any) -> Optional[str]:
    return None if v is None or v == "" else str(v)[:256]


def _ms(seconds: Any) -> Optional[float]:
    try:
        return round(float(seconds) * 1000.0, 3)
    except (TypeError, ValueError):
        return None


def hermes_price(model: str, provider: str, base_url: str, usage: Mapping[str, Any]) -> Optional[tuple[str, Optional[float]]]:
    """Price one call the way Hermes prices it for /usage and state.db.

    agent.usage_pricing.estimate_usage_cost is not on Hermes' public plugin
    surface (only CostResult is), so a Hermes that moves it costs us the cost
    figure, never the plugin: any failure returns None and the call is sent
    with tokens only.
    """
    try:
        from dataclasses import fields

        from agent.usage_pricing import CanonicalUsage, estimate_usage_cost  # type: ignore
    except Exception:
        return None
    try:
        names = {f.name for f in fields(CanonicalUsage) if f.name != "raw_usage"}
        cu = CanonicalUsage(**{k: _int(v) for k, v in usage.items() if k in names})
        r = estimate_usage_cost(model or "", cu, provider=provider or None, base_url=base_url or None, api_key="")
        status = str(getattr(r, "status", "") or "unknown")
        amount = getattr(r, "amount_usd", None)
        return status, (float(amount) if amount is not None and status in PRICED else None)
    except Exception:
        return None


class Mapper:
    """Holds the emit callbacks and turns each hook's kwargs into records."""

    def __init__(self, emit_log: Emit, emit_point: Emit, flush: Callable[[], None], pricer: Pricer = hermes_price):
        self._log = emit_log
        self._point = emit_point
        self._flush = flush
        self._price = pricer
        self._last_session = ""

    # -- helpers -------------------------------------------------------------
    def _sid(self, kw: Mapping[str, Any]) -> str:
        sid = kw.get("session_id") or ""
        if sid:
            self._last_session = str(sid)
            return str(sid)
        return self._last_session

    @staticmethod
    def _ids(raw: str) -> dict[str, Any]:
        return {SESSION: session_uuid(raw) or None, RAW_SESSION: raw or None}

    def _event(self, name: str, kw: Mapping[str, Any], attrs: Mapping[str, Any], severity: int = otlp.SEVERITY_INFO, sid: Optional[str] = None) -> None:
        a = {**self._ids(sid if sid is not None else self._sid(kw)), **attrs}
        self._log({"event_name": name, "time_ns": _now_ns(), "severity": severity, "attributes": {k: v for k, v in a.items() if v is not None}})

    def _metric(self, name: str, unit: str, value: float, attrs: Mapping[str, Any], description: str = "") -> None:
        self._point({
            "name": name, "unit": unit, "description": description, "value": float(value), "time_ns": _now_ns(),
            "attributes": {k: v for k, v in attrs.items() if v is not None},
        })

    # -- sessions ------------------------------------------------------------
    def on_session_start(self, **kw: Any) -> None:
        sid = self._sid(kw)
        self._event("hermes.session.start", kw, {"model": _str(kw.get("model")), "platform": _str(kw.get("platform"))}, sid=sid)
        self._metric("hermes.session.count", "{session}", 1, {**self._ids(sid), "platform": _str(kw.get("platform"))}, "Hermes sessions started")

    def on_session_end(self, **kw: Any) -> None:
        self._event("hermes.session.end", kw, {
            "model": _str(kw.get("model")),
            "platform": _str(kw.get("platform")),
            "completed": bool(kw.get("completed")) if "completed" in kw else None,
            "interrupted": bool(kw.get("interrupted")) if "interrupted" in kw else None,
            "failed": bool(kw.get("failed")) if "failed" in kw else None,
            "exit_reason": _str(kw.get("turn_exit_reason")),
        })
        self._flush()

    def on_session_finalize(self, **kw: Any) -> None:
        self._event("hermes.session.finalize", kw, {})
        self._flush()

    def on_session_reset(self, **kw: Any) -> None:
        new = _str(kw.get("new_session_id")) or self._sid(kw)
        self._event("hermes.session.reset", kw, {"previous_session_id": _str(kw.get("old_session_id"))}, sid=new or "")
        if new:
            self._last_session = new

    # -- model calls ---------------------------------------------------------
    def _usage(self, kw: Mapping[str, Any], kind: str, event: str) -> None:
        sid = self._sid(kw)
        usage = kw.get("usage") if isinstance(kw.get("usage"), Mapping) else {}
        model = _str(kw.get("response_model")) or _str(kw.get("model")) or ""
        provider = _str(kw.get("provider")) or ""
        tokens = {label: _int(usage.get(src)) for src, label in TOKEN_TYPES}
        priced = self._price(model, provider, str(kw.get("base_url") or ""), usage) if usage else None
        status, usd = priced if priced else ("unknown", None)
        common = {**self._ids(sid), "model": model or None, "provider": provider or None, "hermes.call_kind": kind}
        attrs = {
            "model": model or None,
            "provider": provider or None,
            "api_mode": _str(kw.get("api_mode")),
            "hermes.call_kind": kind,
            "aux_task": _str(kw.get("aux_task")),
            "api_request_id": _str(kw.get("api_request_id")),
            "turn_id": _str(kw.get("turn_id")),
            "duration_ms": _ms(kw.get("api_duration")),
            "finish_reason": _str(kw.get("finish_reason")),
            "api_call_count": _int(kw.get("api_call_count")) if kw.get("api_call_count") is not None else None,
            "tool_call_count": _int(kw.get("assistant_tool_call_count")) if kw.get("assistant_tool_call_count") is not None else None,
            "input_tokens": tokens["input"],
            "output_tokens": tokens["output"],
            "cache_read_tokens": tokens["cache_read"],
            "cache_creation_tokens": tokens["cache_creation"],
            "reasoning_tokens": tokens["reasoning"],
            "cost_usd": usd,
            "cost_status": status,
        }
        first = kw.get("first_chunk_at")
        started = kw.get("started_at")
        if isinstance(first, (int, float)) and isinstance(started, (int, float)):
            attrs["ttfb_ms"] = _ms(first - started)
        err = kw.get("error")
        if err:
            attrs["error_type"] = _str(kw.get("error_type")) or "error"
        self._event(event, kw, attrs, otlp.SEVERITY_WARN if err else otlp.SEVERITY_INFO, sid=sid)
        for label, n in tokens.items():
            if n:
                self._metric("hermes.token.usage", "{token}", n, {**common, "type": label}, "Tokens per model call, by type (input excludes cache)")
        if usd is not None:
            self._metric("hermes.cost.usage", "USD", usd, {**common, "cost_status": status}, "USD per model call, as priced by Hermes")

    def post_api_request(self, **kw: Any) -> None:
        self._usage(kw, "main", "hermes.api_request")

    def post_auxiliary_call(self, **kw: Any) -> None:
        self._usage(kw, "auxiliary", "hermes.auxiliary_request")

    def api_request_error(self, **kw: Any) -> None:
        err = kw.get("error") if isinstance(kw.get("error"), Mapping) else {}
        self._event("hermes.api_error", kw, {
            "model": _str(kw.get("model")),
            "provider": _str(kw.get("provider")),
            "api_request_id": _str(kw.get("api_request_id")),
            "turn_id": _str(kw.get("turn_id")),
            "status_code": _int(kw.get("status_code")) if kw.get("status_code") is not None else None,
            "error_type": _str(err.get("type")),  # the type only: provider messages can echo the prompt
            "reason": _str(kw.get("reason")),
            "retry_count": _int(kw.get("retry_count")) if kw.get("retry_count") is not None else None,
            "retryable": bool(kw.get("retryable")) if "retryable" in kw else None,
            "duration_ms": _ms(kw.get("api_duration")),
        }, otlp.SEVERITY_WARN)

    # -- tools ---------------------------------------------------------------
    def post_tool_call(self, **kw: Any) -> None:
        sid = self._sid(kw)
        tool = _str(kw.get("tool_name")) or "unknown"
        status = _str(kw.get("status")) or ("error" if kw.get("error_type") else "ok")
        self._event("hermes.tool_result", kw, {
            "tool_name": tool,
            "tool_call_id": _str(kw.get("tool_call_id")),
            "turn_id": _str(kw.get("turn_id")),
            "api_request_id": _str(kw.get("api_request_id")),
            "status": status,
            "success": status == "ok",
            "duration_ms": float(kw["duration_ms"]) if isinstance(kw.get("duration_ms"), (int, float)) else None,
            "error_type": _str(kw.get("error_type")),
            "mcp_server": tool.split("__")[1] if tool.startswith("mcp__") and tool.count("__") >= 2 else None,
        }, otlp.SEVERITY_INFO if status == "ok" else otlp.SEVERITY_WARN, sid=sid)
        self._metric("hermes.tool.count", "{call}", 1, {**self._ids(sid), "tool_name": tool, "status": status}, "Tool calls by outcome")

    # -- sub-agents ----------------------------------------------------------
    def subagent_start(self, **kw: Any) -> None:
        parent = _str(kw.get("parent_session_id")) or self._last_session
        self._event("hermes.subagent.start", kw, {
            "parent_session_id": parent,
            "child_session_id": _str(kw.get("child_session_id")),
            "child_session_uuid": session_uuid(_str(kw.get("child_session_id")) or "") or None,
            "child_subagent_id": _str(kw.get("child_subagent_id")),
            "child_role": _str(kw.get("child_role")),
        }, sid=parent or "")

    def subagent_stop(self, **kw: Any) -> None:
        parent = _str(kw.get("parent_session_id")) or self._last_session
        history = kw.get("tool_call_history")
        self._event("hermes.subagent.stop", kw, {
            "parent_session_id": parent,
            "child_session_id": _str(kw.get("child_session_id")),
            "child_session_uuid": session_uuid(_str(kw.get("child_session_id")) or "") or None,
            "child_subagent_id": _str(kw.get("child_subagent_id")),
            "child_role": _str(kw.get("child_role")),
            "status": _str(kw.get("status") or kw.get("child_status")),
            "duration_ms": float(kw["duration_ms"]) if isinstance(kw.get("duration_ms"), (int, float)) else None,
            "tool_call_count": len(history) if isinstance(history, list) else None,
        }, sid=parent or "")

    # -- approvals -----------------------------------------------------------
    def post_approval_response(self, **kw: Any) -> None:
        # The command and its description are content; the choice and surface are not.
        self._event("hermes.approval", kw, {
            "choice": _str(kw.get("choice")),
            "surface": _str(kw.get("surface")),
            "decided_by": _str(kw.get("decided_by")),
        })


HOOKS = (
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
    "post_api_request",
    "post_auxiliary_call",
    "api_request_error",
    "post_tool_call",
    "subagent_start",
    "subagent_stop",
    "post_approval_response",
)
