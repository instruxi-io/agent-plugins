from __future__ import annotations

import time
import unittest

import pbwire
from _load import plugin
from sink import Sink

plugin()
from enforcer_hermes import exporter, settings  # noqa: E402

RES = {"service.name": "hermes"}


def log(name="hermes.tool_result", sid="s1"):
    return {"event_name": name, "time_ns": time.time_ns(), "attributes": {"session.id": sid}}


def point(v=1.0, sid="s1"):
    return {"name": "hermes.token.usage", "unit": "{token}", "value": v, "time_ns": time.time_ns(), "attributes": {"session.id": sid, "type": "input"}}


class Keys:
    """A scripted `enforcer ingest-key`: each call returns the next key (or raises)."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(a, Exception):
            raise a
        return a


class AgainstAFakeSink(unittest.TestCase):
    def setUp(self):
        self.sink = Sink()
        self.base = f"{self.sink.origin}/api/v1/governance/otlp"

    def tearDown(self):
        self.sink.close()

    def key(self, k="ik_1", **kw):
        return settings.IngestKey(key=k, otlp_base=self.base, **kw)

    def test_a_batch_is_posted_as_gzip_protobuf_with_the_ingest_key_to_logs_and_metrics(self):
        e = exporter.Exporter(RES, "https://unused.example", Keys(self.key()))
        e.emit_log(log())
        e.emit_point(point(200))
        self.assertTrue(e.export_once())
        paths = [r["path"] for r in self.sink.requests]
        self.assertEqual(paths, ["/api/v1/governance/otlp/v1/logs", "/api/v1/governance/otlp/v1/metrics"])
        for r in self.sink.requests:
            self.assertEqual(r["headers"]["x-api-key"], "ik_1")
            self.assertEqual(r["headers"]["content-type"], "application/x-protobuf")
        got = pbwire.logs(self.sink.requests[0]["body"])
        self.assertEqual(got["resource"]["service.name"], "hermes")
        self.assertEqual(got["records"][0]["event_name"], "hermes.tool_result")
        self.assertEqual(pbwire.metrics(self.sink.requests[1]["body"])["points"][0]["value"], 200.0)
        self.assertEqual((e.stats.exported_logs, e.stats.exported_points), (1, 1))

    def test_without_otlp_base_the_endpoint_is_built_from_the_origin(self):
        e = exporter.Exporter(RES, self.sink.origin, Keys(settings.IngestKey(key="ik")))
        e.emit_log(log())
        e.export_once()
        self.assertEqual(self.sink.requests[0]["path"], "/api/v1/governance/otlp/v1/logs")

    def test_a_401_asks_the_cli_once_and_retries_with_the_new_key(self):
        keys = Keys(self.key("ik_old"), self.key("ik_new", source="rotated"))
        self.sink.statuses = [401]
        e = exporter.Exporter(RES, "", keys)
        e.emit_log(log())
        e.export_once()
        self.assertEqual([r["headers"]["x-api-key"] for r in self.sink.requests], ["ik_old", "ik_new"])
        self.assertEqual((keys.calls, e.stats.exported_logs, e.stats.key_source), (2, 1, "rotated"))

    def test_a_revoked_key_with_no_replacement_drops_the_batch_without_looping(self):
        keys = Keys(self.key("ik_old"), settings.KeyError_("signed out of Enforcer", 3))
        self.sink.statuses = [401]
        e = exporter.Exporter(RES, "", keys)
        e.emit_log(log())
        e.export_once()
        self.assertEqual(len(self.sink.requests), 1)
        self.assertEqual(e.stats.dropped_export, 1)
        self.assertIn("signed out", e.stats.key_error)

    def test_no_key_means_nothing_is_sent_and_the_cli_is_not_rerun_per_batch(self):
        keys = Keys(settings.KeyError_("the enforcer CLI was not found"))
        e = exporter.Exporter(RES, self.sink.origin, keys)
        for _ in range(3):
            e.emit_log(log())
            e.export_once()
        self.assertEqual(self.sink.requests, [])
        self.assertEqual((keys.calls, e.stats.dropped_no_key), (1, 3))
        self.assertIn("not found", e.stats.key_error)

    def test_a_5xx_is_retried_then_dropped_and_a_400_is_not_retried(self):
        exporter_sleep = exporter.time.sleep
        exporter.time.sleep = lambda s: None
        try:
            self.sink.statuses = [503, 503, 503]
            e = exporter.Exporter(RES, "", Keys(self.key()))
            e.emit_log(log())
            e.export_once()
            self.assertEqual(len(self.sink.requests), 1 + exporter.RETRIES)
            self.assertEqual(e.stats.dropped_export, 1)
            self.sink.requests.clear()
            self.sink.statuses = [400]
            e.emit_log(log())
            e.export_once()
            self.assertEqual(len(self.sink.requests), 1)
            self.assertEqual(e.stats.last_error, "logs: HTTP 400")
        finally:
            exporter.time.sleep = exporter_sleep

    def test_an_unreachable_governance_never_raises(self):
        self.sink.close()
        exporter_sleep = exporter.time.sleep
        exporter.time.sleep = lambda s: None
        try:
            e = exporter.Exporter(RES, "", Keys(self.key()))
            e.emit_log(log())
            e.export_once()
            self.assertEqual(e.stats.dropped_export, 1)
            self.assertTrue(e.stats.last_error.startswith("logs:"))
        finally:
            exporter.time.sleep = exporter_sleep
            self.sink = Sink()  # tearDown closes it

    def test_the_queue_is_bounded_and_drops_past_its_limit(self):
        e = exporter.Exporter(RES, "", Keys(self.key()), max_queue=3, interval=3600)
        t0 = time.monotonic()
        for _ in range(5):
            e.emit_log(log())
        self.assertLess(time.monotonic() - t0, 0.5, "a full queue must drop, not wait")
        self.assertEqual(e.stats.dropped_queue_full, 2)

    def test_emitting_never_waits_on_a_slow_governance(self):
        self.sink.delay = 2.0
        e = exporter.Exporter(RES, "", Keys(self.key()), batch_size=1, interval=0.01)
        t0 = time.monotonic()
        for _ in range(50):
            e.emit_log(log())
        self.assertLess(time.monotonic() - t0, 0.5)
        e.shutdown(timeout=0.1)

    def test_the_worker_thread_exports_on_its_own(self):
        e = exporter.Exporter(RES, "", Keys(self.key()), interval=0.05)
        e.emit_log(log())
        deadline = time.monotonic() + 3
        while not self.sink.requests and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(self.sink.requests), 1)
        e.shutdown(timeout=0.5)


if __name__ == "__main__":
    unittest.main()
