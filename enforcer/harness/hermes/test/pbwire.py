"""A protobuf wire-format reader written independently of otlp.py, so the
tests check the encoder against the OTLP field numbers rather than against
itself. Field numbers: opentelemetry-proto v1 (collector/{logs,metrics}/v1,
logs/v1, metrics/v1, common/v1)."""

from __future__ import annotations

import struct


def fields(buf: bytes) -> list[tuple[int, int, object]]:
    out, i = [], 0
    while i < len(buf):
        key, i = _varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            v, i = _varint(buf, i)
        elif wire == 1:
            v = buf[i : i + 8]
            i += 8
        elif wire == 2:
            n, i = _varint(buf, i)
            v = buf[i : i + n]
            if len(v) != n:
                raise ValueError("truncated length-delimited field")
            i += n
        elif wire == 5:
            v = buf[i : i + 4]
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
        out.append((num, wire, v))
    return out


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = n = 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, i
        shift += 7


def get(buf: bytes, num: int) -> list:
    return [v for n, _, v in fields(buf) if n == num]


def one(buf: bytes, num: int):
    vs = get(buf, num)
    assert len(vs) == 1, f"field {num}: {len(vs)} values"
    return vs[0]


def fixed64(b: bytes) -> int:
    return struct.unpack("<Q", b)[0]


def double(b: bytes) -> float:
    return struct.unpack("<d", b)[0]


def any_value(b: bytes):
    (num, wire, v), = fields(b) or [(1, 2, b"")]
    if num == 1:
        return v.decode("utf-8")
    if num == 2:
        return bool(v)
    if num == 3:
        return v - (1 << 64) if v >= 1 << 63 else v
    if num == 4:
        return double(v)
    if num == 5:
        return [any_value(x) for x in get(v, 1)]
    raise ValueError(f"AnyValue field {num}")


def kvs(msg: bytes, num: int) -> dict:
    return {one(kv, 1).decode(): any_value(one(kv, 2)) for kv in get(msg, num)}


def logs(body: bytes) -> dict:
    """ExportLogsServiceRequest -> {resource, scope, records:[{time, severity, body, attrs, event_name}]}"""
    (rl,) = get(body, 1)
    resource = kvs(one(rl, 1), 1)
    (sl,) = get(rl, 2)
    scope = one(sl, 1)
    recs = []
    for lr in get(sl, 2):
        recs.append({
            "time": fixed64(one(lr, 1)),
            "severity": one(lr, 2),
            "body": any_value(one(lr, 5)),
            "attrs": kvs(lr, 6),
            "event_name": one(lr, 12).decode(),
        })
    return {"resource": resource, "scope": one(scope, 1).decode(), "records": recs}


def metrics(body: bytes) -> dict:
    """ExportMetricsServiceRequest -> {resource, points:[{name, unit, temporality, monotonic, value, attrs, time}]}"""
    (rm,) = get(body, 1)
    resource = kvs(one(rm, 1), 1)
    (sm,) = get(rm, 2)
    pts = []
    for m in get(sm, 2):
        name = one(m, 1).decode()
        unit = (get(m, 3) or [b""])[0].decode()
        s = one(m, 7)  # Sum
        temporality = one(s, 2)
        monotonic = bool(one(s, 3))
        for dp in get(s, 1):
            pts.append({
                "name": name, "unit": unit, "temporality": temporality, "monotonic": monotonic,
                "value": double(one(dp, 4)), "time": fixed64(one(dp, 3)), "attrs": kvs(dp, 7),
            })
    return {"resource": resource, "points": pts}
