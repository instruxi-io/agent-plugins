from __future__ import annotations

import os
import unittest
from unittest import mock

from _load import plugin

ehp = plugin()
from enforcer_hermes import events  # noqa: E402


class FakeCtx:
    """The parts of Hermes' PluginContext register() touches."""

    def __init__(self, settings=None):
        self.settings = dict(settings or {})
        self.hooks: dict = {}
        self.cli: dict = {}
        self.commands: dict = {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def set_config(self, key, value):
        self.settings[key] = value

    def register_hook(self, name, cb):
        self.hooks.setdefault(name, []).append(cb)

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli[name] = (setup_fn, handler_fn)

    def register_command(self, name, handler, description=""):
        self.commands[name] = handler


class Register(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"ENFORCER_INGEST_KEY": "ik_test", "ENFORCER_BASE_URL": "http://127.0.0.1:9"})
        self.env.start()
        os.environ.pop("ENFORCER_TELEMETRY", None)

    def tearDown(self):
        exp = ehp._state.get("exporter")
        if exp is not None:
            exp._stop.set()
        self.env.stop()

    def test_telemetry_is_on_by_default_and_every_hook_is_registered(self):
        ctx = FakeCtx()
        ehp.register(ctx)
        self.assertEqual(sorted(ctx.hooks), sorted(events.HOOKS))
        self.assertIn("enforcer", ctx.cli)
        self.assertIn("enforcer", ctx.commands)
        self.assertEqual(ehp.status(ctx)["telemetry"], "on")

    def test_the_setting_turns_it_off_and_registers_no_hooks(self):
        ctx = FakeCtx({"telemetry": False})
        ehp.register(ctx)
        self.assertEqual(ctx.hooks, {})
        self.assertEqual(ehp.status(ctx)["telemetry"], "off")
        self.assertIn("enforcer", ctx.cli)  # status and `telemetry on` still work

    def test_hooks_fail_open_and_return_nothing(self):
        ctx = FakeCtx()
        ehp.register(ctx)
        exp = ehp._state["exporter"]
        exp.emit_log = mock.Mock(side_effect=RuntimeError("boom"))
        for name, cbs in ctx.hooks.items():
            for cb in cbs:
                self.assertIsNone(cb(session_id="s", usage="not-a-dict", duration_ms="x", tool_call_history=5))

    def test_the_cli_toggles_the_setting(self):
        import argparse

        ctx = FakeCtx()
        ehp.register(ctx)
        setup, handle = ctx.cli["enforcer"]
        p = argparse.ArgumentParser()
        setup(p)
        with mock.patch("builtins.print"):
            handle(p.parse_args(["telemetry", "off"]))
        self.assertIs(ctx.settings["telemetry"], False)

    def test_status_names_the_mcp_command_and_how_to_turn_off(self):
        ctx = FakeCtx()
        ehp.register(ctx)
        s = ehp.status(ctx)
        self.assertEqual(s["mcp"]["add_with"], "hermes mcp add enforcer --url http://127.0.0.1:9/mcp --auth oauth")
        self.assertIn("telemetry false", s["turn_off"])


if __name__ == "__main__":
    unittest.main()
