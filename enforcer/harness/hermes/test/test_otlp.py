from __future__ import annotations

import unittest

import pbwire
from _load import plugin

plugin()
from enforcer_hermes import otlp  # noqa: E402


class EncodeLogs(unittest.TestCase):
    def test_a_record_carries_its_event_name_three_ways_and_typed_attributes(self):
        body = otlp.encode_logs(
            {"service.name": "hermes"},
            ("enforcer.hermes", "1"),
            [{"event_name": "hermes.tool_result", "time_ns": 1_700_000_000_123_456_789, "severity": otlp.SEVERITY_WARN,
              "attributes": {"session.id": "s-1", "success": False, "duration_ms": 12.5, "count": 3, "neg": -2, "empty": "", "skip": None}}],
        )
        got = pbwire.logs(body)
        self.assertEqual(got["resource"], {"service.name": "hermes"})
        self.assertEqual(got["scope"], "enforcer.hermes")
        (r,) = got["records"]
        self.assertEqual(r["event_name"], "hermes.tool_result")
        self.assertEqual(r["body"], "hermes.tool_result")
        self.assertEqual(r["time"], 1_700_000_000_123_456_789)
        self.assertEqual(r["severity"], otlp.SEVERITY_WARN)
        self.assertEqual(r["attrs"], {"event.name": "hermes.tool_result", "session.id": "s-1", "success": False,
                                      "duration_ms": 12.5, "count": 3, "neg": -2, "empty": ""})


class EncodeMetrics(unittest.TestCase):
    def test_points_are_monotonic_delta_sums_grouped_by_name(self):
        body = otlp.encode_metrics(
            {"service.name": "hermes"},
            ("enforcer.hermes", "1"),
            [
                {"name": "hermes.token.usage", "unit": "{token}", "value": 200, "time_ns": 5, "attributes": {"type": "input", "session.id": "s"}},
                {"name": "hermes.cost.usage", "unit": "USD", "value": 0.000129, "time_ns": 6, "attributes": {"session.id": "s"}},
                {"name": "hermes.token.usage", "unit": "{token}", "value": 40, "time_ns": 7, "attributes": {"type": "output", "session.id": "s"}},
            ],
        )
        got = pbwire.metrics(body)
        self.assertEqual([(p["name"], p["value"], p["attrs"].get("type")) for p in got["points"]],
                         [("hermes.token.usage", 200.0, "input"), ("hermes.token.usage", 40.0, "output"), ("hermes.cost.usage", 0.000129, None)])
        for p in got["points"]:
            self.assertEqual(p["temporality"], 1)  # AGGREGATION_TEMPORALITY_DELTA in metrics/v1
            self.assertTrue(p["monotonic"])
        self.assertEqual({p["name"]: p["unit"] for p in got["points"]}, {"hermes.token.usage": "{token}", "hermes.cost.usage": "USD"})


if __name__ == "__main__":
    unittest.main()
