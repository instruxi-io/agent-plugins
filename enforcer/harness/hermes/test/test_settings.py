from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from _load import plugin

plugin()
from enforcer_hermes import settings  # noqa: E402


def ran(stdout="", code=0, stderr=""):
    calls = []

    def runner(argv, timeout):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, code, stdout, stderr)

    return runner, calls


GOOD = json.dumps({"key": "ik_abc", "credentialId": "cred-1", "agentId": "ag-1", "expiresAt": "2026-12-01T00:00:00Z",
                   "source": "minted", "harness": "hermes", "otlpBase": "https://gov.example/api/v1/governance/otlp"})


class FetchKey(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"ENFORCER_CLI": "/opt/enforcer"}, clear=False)
        self.env.start()
        os.environ.pop("ENFORCER_INGEST_KEY", None)

    def tearDown(self):
        self.env.stop()

    def test_it_runs_the_contracted_command_and_reads_its_json(self):
        runner, calls = ran(GOOD)
        k = settings.fetch_key(runner=runner)
        self.assertEqual(calls, [["/opt/enforcer", "ingest-key", "--harness", "hermes", "--json"]])
        self.assertEqual((k.key, k.credential_id, k.agent_id, k.source, k.otlp_base),
                         ("ik_abc", "cred-1", "ag-1", "minted", "https://gov.example/api/v1/governance/otlp"))
        self.assertGreater(k.expires_at, 1.7e9)
        self.assertEqual(settings.otlp_endpoint("https://ignored", "metrics", k.otlp_base),
                         "https://gov.example/api/v1/governance/otlp/v1/metrics")

    def test_signed_out_and_disabled_exit_codes_say_so_and_never_leak_stdout(self):
        for code, words in ((3, "signed out"), (4, "disabled")):
            runner, _ = ran('{"key":"should-not-show"}', code, "detail line")
            with self.assertRaises(settings.KeyError_) as cm:
                settings.fetch_key(runner=runner)
            self.assertIn(words, str(cm.exception))
            self.assertNotIn("should-not-show", str(cm.exception))
            self.assertEqual(cm.exception.code, code)

    def test_garbage_or_keyless_output_is_an_error(self):
        for out in ("not json", "{}", '{"key": ""}'):
            runner, _ = ran(out)
            with self.assertRaises(settings.KeyError_):
                settings.fetch_key(runner=runner)

    def test_a_cli_that_cannot_start_or_hangs_is_an_error(self):
        def boom(argv, timeout):
            raise FileNotFoundError(2, "No such file")

        def hang(argv, timeout):
            raise subprocess.TimeoutExpired(argv, timeout)

        for r in (boom, hang):
            with self.assertRaises(settings.KeyError_):
                settings.fetch_key(runner=r)

    def test_an_explicit_key_skips_the_cli(self):
        with mock.patch.dict(os.environ, {"ENFORCER_INGEST_KEY": "ik_env"}):
            runner, calls = ran(GOOD)
            k = settings.fetch_key(runner=runner)
        self.assertEqual((k.key, k.source, calls), ("ik_env", "env", []))


class Resolution(unittest.TestCase):
    def test_base_url_precedence(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "credentials.json").write_text(json.dumps({"enforcer": {"base_url": "https://saved.example/x"}}))
            with mock.patch.dict(os.environ, {"ENFORCER_HOME": d}, clear=False):
                os.environ.pop("ENFORCER_BASE_URL", None)
                self.assertEqual(settings.base_url(), "https://saved.example")
                with mock.patch.dict(os.environ, {"ENFORCER_BASE_URL": "http://localhost:8080/"}):
                    self.assertEqual(settings.base_url(), "http://localhost:8080")
                    self.assertEqual(settings.base_url("https://setting.example"), "https://setting.example")
            with mock.patch.dict(os.environ, {"ENFORCER_HOME": d + "/none"}, clear=False):
                os.environ.pop("ENFORCER_BASE_URL", None)
                self.assertEqual(settings.base_url(), settings.DEFAULT_BASE_URL)

    def test_there_is_no_traces_endpoint(self):
        with self.assertRaises(ValueError):
            settings.otlp_endpoint("https://x", "traces")

    def test_telemetry_is_on_unless_turned_off(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ENFORCER_TELEMETRY", None)
            self.assertTrue(settings.telemetry_enabled(None))
            self.assertTrue(settings.telemetry_enabled(True))
            self.assertFalse(settings.telemetry_enabled(False))
            self.assertFalse(settings.telemetry_enabled("off"))
        with mock.patch.dict(os.environ, {"ENFORCER_TELEMETRY": "0"}):
            self.assertFalse(settings.telemetry_enabled(True))

    def test_the_cli_is_found_from_plugin_root(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, "enforcer", "1.6.0")
            (root / "bin").mkdir(parents=True)
            (root / "bin" / "enforcer").write_text("#!/usr/bin/env node\n")
            (root / "lib" / "governor").mkdir(parents=True)
            Path(d, "plugin-root").write_text(str(root / "lib" / "governor"))
            env = {"ENFORCER_HOME": d, "PATH": "/nonexistent"}
            with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(settings.shutil, "which", lambda n: "/usr/bin/node" if n == "node" else None):
                os.environ.pop("ENFORCER_CLI", None)
                self.assertEqual(settings.find_cli(), ["/usr/bin/node", str(root / "bin" / "enforcer")])


if __name__ == "__main__":
    unittest.main()
