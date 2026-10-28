"""OTLP/HTTP protobuf encoding for logs and metrics, with no dependencies.

Hermes plugins that import opentelemetry-* need a dependency-consent step and
a PM admission, and a broken wheel would disable the plugin. The two messages
this plugin sends are small and fixed, so they are written straight to the
protobuf wire format here (field numbers from opentelemetry-proto v1:
collector/logs/v1, collector/metrics/v1, logs/v1, metrics/v1, common/v1,
resource/v1). Only what governance reads is encoded.
"""

from __future__ import annotations

import struct
from typing import Any, Iterable, Mapping

# metrics/v1 AggregationTemporality
DELTA = 1
# logs/v1 SeverityNumber
SEVERITY_INFO = 9
SEVERITY_WARN = 13

_VARINT, _I64, _LEN, _I32 = 0, 1, 2, 5


def _varint(n: int) -> bytes:
    if n < 0:  # int64 two's complement, as protobuf encodes negative int64
        n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _tag(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def _len(field: int, payload: bytes) -> bytes:
    return _tag(field, _LEN) + _varint(len(payload)) + payload


def _str(field: int, s: str) -> bytes:
    return _len(field, s.encode("utf-8")) if s else b""


def _fixed64(field: int, n: int) -> bytes:
    return _tag(field, _I64) + struct.pack("<Q", n & ((1 << 64) - 1))


def _double(field: int, v: float) -> bytes:
    return _tag(field, _I64) + struct.pack("<d", float(v))


def any_value(v: Any) -> bytes:
    """common/v1 AnyValue. bool before int: bool is an int in Python."""
    if isinstance(v, bool):
        return _tag(2, _VARINT) + _varint(1 if v else 0)
    if isinstance(v, int):
        return _tag(3, _VARINT) + _varint(v)
    if isinstance(v, float):
        return _double(4, v)
    if isinstance(v, (list, tuple)):
        return _len(5, b"".join(_len(1, any_value(x)) for x in v))
    # An empty string is still a string_value: tag + zero length.
    return _tag(1, _LEN) + _varint(len(str(v).encode("utf-8"))) + str(v).encode("utf-8")


def key_values(field: int, attrs: Mapping[str, Any]) -> bytes:
    """repeated common/v1 KeyValue under `field`; None values are left out."""
    return b"".join(
        _len(field, _str(1, k) + _len(2, any_value(v))) for k, v in attrs.items() if v is not None
    )


def _scope(name: str, version: str) -> bytes:
    return _len(1, _str(1, name) + _str(2, version))


def _resource(attrs: Mapping[str, Any]) -> bytes:
    return _len(1, key_values(1, attrs))


def encode_logs(resource: Mapping[str, Any], scope: tuple[str, str], records: Iterable[Mapping[str, Any]]) -> bytes:
    """ExportLogsServiceRequest with one resource and one scope.

    A record is {time_ns, event_name, severity (int), attributes}. The event
    name is sent three ways because receivers differ in where they look:
    LogRecord.event_name (field 12), the `event.name` attribute, and the body.
    """
    out = bytearray()
    for r in records:
        name = r["event_name"]
        attrs = {"event.name": name, **r.get("attributes", {})}
        t = int(r["time_ns"])
        sev = int(r.get("severity", SEVERITY_INFO))
        lr = (
            _fixed64(1, t)
            + _tag(2, _VARINT) + _varint(sev)
            + _str(3, "WARN" if sev >= SEVERITY_WARN else "INFO")
            + _len(5, any_value(name))
            + key_values(6, attrs)
            + _fixed64(11, t)
            + _str(12, name)
        )
        out += _len(2, lr)
    scope_logs = _scope(*scope) + bytes(out)
    resource_logs = _resource(resource) + _len(2, scope_logs)
    return _len(1, resource_logs)


def encode_metrics(resource: Mapping[str, Any], scope: tuple[str, str], points: Iterable[Mapping[str, Any]]) -> bytes:
    """ExportMetricsServiceRequest of monotonic DELTA sums, one data point per
    observation (governance rolls deltas up itself; nothing is aggregated here,
    so a point keeps the exact time and attributes of the call it measures).

    A point is {name, unit, description, value (float), time_ns, attributes}.
    Points are grouped by name so each Metric carries all of its data points.
    """
    by_name: dict[str, list[Mapping[str, Any]]] = {}
    for p in points:
        by_name.setdefault(p["name"], []).append(p)
    metrics = bytearray()
    for name, pts in by_name.items():
        dps = bytearray()
        for p in pts:
            t = int(p["time_ns"])
            dps += _len(
                1,
                _fixed64(2, t)  # start_time_unix_nano
                + _fixed64(3, t)  # time_unix_nano
                + _double(4, float(p["value"]))  # as_double
                + key_values(7, p.get("attributes", {})),
            )
        total = bytes(dps) + _tag(2, _VARINT) + _varint(DELTA) + _tag(3, _VARINT) + _varint(1)
        first = pts[0]
        metrics += _len(2, _str(1, name) + _str(2, first.get("description", "")) + _str(3, first.get("unit", "")) + _len(7, total))
    scope_metrics = _scope(*scope) + bytes(metrics)
    resource_metrics = _resource(resource) + _len(2, scope_metrics)
    return _len(1, resource_metrics)
