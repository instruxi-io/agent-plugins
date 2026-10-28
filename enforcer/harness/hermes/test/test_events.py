from __future__ import annotations

import json
import unittest

from _load import plugin

plugin()
from enforcer_hermes import events  # noqa: E402

SECRETS = ("SECRET_PROMPT", "SECRET_RESPONSE", "SECRET_ARG", "SECRET_RESULT", "SECRET_GOAL", "SECRET_SUMMARY", "SECRET_ERRMSG", "SECRET_COMMAND")

USAGE = {"input_tokens": 200, "output_tokens": 40, "cache_read_tokens": 1000, "cache_write_tokens": 5, "reasoning_tokens": 10,
         "request_count": 1, "prompt_tokens": 1205, "total_tokens": 1245}


def mapper(price=lambda *a: ("estimated", 0.25)):
    logs, pts, flushes = [], [], []
    return events.Mapper(logs.append, pts.append, lambda: flushes.append(1), pricer=price), logs, pts, flushes


class Mapping(unittest.TestCase):
    def test_a_model_call_becomes_one_event_token_points_by_type_and_a_cost_point(self):
        m, logs, pts, _ = mapper()
        m.post_api_request(session_id="sess-1", model="gpt-4o-mini", provider="openai", usage=USAGE, api_duration=1.5,
                           started_at=100.0, first_chunk_at=100.25, finish_reason="stop", api_request_id="r1", turn_id="t1")
        (ev,) = logs
        self.assertEqual(ev["event_name"], "hermes.api_request")
        a = ev["attributes"]
        self.assertEqual((a["session.id"], a["input_tokens"], a["cache_read_tokens"], a["cache_creation_tokens"], a["cost_usd"], a["duration_ms"], a["ttfb_ms"]),
                         ("sess-1", 200, 1000, 5, 0.25, 1500.0, 250.0))
        got = {(p["name"], p["attributes"].get("type")): p["value"] for p in pts}
        self.assertEqual(got, {
            ("hermes.token.usage", "input"): 200, ("hermes.token.usage", "output"): 40,
            ("hermes.token.usage", "cache_read"): 1000, ("hermes.token.usage", "cache_creation"): 5,
            ("hermes.token.usage", "reasoning"): 10, ("hermes.cost.usage", None): 0.25,
        })
        for p in pts:
            self.assertEqual(p["attributes"]["session.id"], "sess-1")
            self.assertEqual(p["attributes"]["model"], "gpt-4o-mini")

    def test_an_unpriced_call_sends_tokens_and_no_cost_point(self):
        m, logs, pts, _ = mapper(price=lambda *a: ("unknown", None))
        m.post_api_request(session_id="s", model="local", usage=USAGE)
        self.assertNotIn("hermes.cost.usage", {p["name"] for p in pts})
        self.assertEqual(logs[0]["attributes"]["cost_status"], "unknown")
        m2, _, pts2, _ = mapper(price=lambda *a: None)  # a Hermes with no pricing module
        m2.post_api_request(session_id="s", model="local", usage=USAGE)
        self.assertNotIn("hermes.cost.usage", {p["name"] for p in pts2})

    def test_auxiliary_calls_count_as_spend_of_the_same_session(self):
        m, logs, pts, _ = mapper()
        m.post_auxiliary_call(session_id="s", aux_task="title_generation", model="m", usage=USAGE)
        self.assertEqual(logs[0]["event_name"], "hermes.auxiliary_request")
        self.assertEqual({p["attributes"]["hermes.call_kind"] for p in pts}, {"auxiliary"})
        self.assertIn("hermes.cost.usage", {p["name"] for p in pts})

    def test_no_content_reaches_any_record(self):
        m, logs, pts, flushes = mapper()
        m.on_session_start(session_id="s", model="m", platform="cli")
        m.post_api_request(session_id="s", model="m", usage=USAGE, request={"messages": [{"content": "SECRET_PROMPT"}]},
                           response={"content": "SECRET_RESPONSE"}, assistant_message="SECRET_RESPONSE", user_message="SECRET_PROMPT")
        m.api_request_error(session_id="s", model="m", status_code=400, error={"type": "BadRequest", "message": "SECRET_ERRMSG"},
                            request={"messages": "SECRET_PROMPT"})
        m.post_tool_call(session_id="s", tool_name="terminal", args={"command": "SECRET_ARG"}, result="SECRET_RESULT",
                         status="error", error_type="Timeout", error_message="SECRET_ERRMSG", duration_ms=5)
        m.subagent_start(parent_session_id="s", child_session_id="c", child_goal="SECRET_GOAL", child_role="worker")
        m.subagent_stop(parent_session_id="s", child_session_id="c", child_summary="SECRET_SUMMARY",
                        tool_call_history=[{"tool_name": "x", "tool_input": {"targets": {"path": "SECRET_ARG"}}}], status="completed")
        m.post_approval_response(session_id="s", command="SECRET_COMMAND", description="SECRET_COMMAND", choice="once", surface="cli")
        m.on_session_end(session_id="s", completed=True)
        dump = json.dumps([logs, pts])
        for s in SECRETS:
            self.assertNotIn(s, dump)
        names = [r["event_name"] for r in logs]
        self.assertEqual(names, ["hermes.session.start", "hermes.api_request", "hermes.api_error", "hermes.tool_result",
                                 "hermes.subagent.start", "hermes.subagent.stop", "hermes.approval", "hermes.session.end"])
        self.assertEqual(flushes, [1])  # session end asks for a flush
        tool = logs[3]["attributes"]
        self.assertEqual((tool["tool_name"], tool["status"], tool["success"], tool["error_type"]), ("terminal", "error", False, "Timeout"))
        self.assertEqual(logs[5]["attributes"]["tool_call_count"], 1)

    def test_every_record_carries_the_session_id_even_when_a_hook_omits_it(self):
        m, logs, pts, _ = mapper()
        m.on_session_start(session_id="sess-9")
        m.post_tool_call(tool_name="read_file", status="ok")  # no session_id in kwargs
        m.post_approval_response(choice="deny")
        self.assertEqual({r["attributes"]["session.id"] for r in logs}, {"sess-9"})
        self.assertEqual({p["attributes"]["session.id"] for p in pts}, {"sess-9"})

    def test_a_reset_moves_later_records_to_the_new_session(self):
        m, logs, _, _ = mapper()
        m.on_session_start(session_id="old")
        m.on_session_reset(old_session_id="old", new_session_id="new")
        m.post_tool_call(tool_name="x", status="ok")
        self.assertEqual([r["attributes"]["session.id"] for r in logs], ["old", "new", "new"])
        self.assertEqual(logs[1]["attributes"]["previous_session_id"], "old")

    def test_hooks_list_matches_the_manifest(self):
        import re
        from pathlib import Path

        text = (Path(events.__file__).parent / "plugin.yaml").read_text()
        block = text.split("provides_hooks:")[1].split("\n\n")[0]
        self.assertEqual(sorted(re.findall(r"^\s+- (\w+)", block, re.M)), sorted(events.HOOKS))


if __name__ == "__main__":
    unittest.main()
