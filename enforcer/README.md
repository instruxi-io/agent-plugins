# enforcer

Install with your harness's own plugin manager. Nothing is copied or shimmed.

```sh
# Claude Code
claude plugin marketplace add instruxi-io/agent-plugins && claude plugin install enforcer@instruxi
# Grok Build
grok plugin marketplace add instruxi-io/agent-plugins && grok plugin install enforcer --trust
# Codex (beta: hooks and skills load; the enforcer MCP sign-in under Codex is not working yet)
codex plugin marketplace add instruxi-io/agent-plugins && codex plugin add enforcer@instruxi
# OpenClaw (native plugin: MCP, skills, telemetry to governance; needs OpenClaw >= 2026.10.8)
openclaw plugins install @openclaw/diagnostics-otel && openclaw plugins install enforcer --marketplace instruxi-io/agent-plugins
# Cursor (experimental: hooks only, from the CLI; or the plugin from .cursor-plugin/marketplace.json)
enforcer harness install cursor            # ~/.cursor/hooks.json; --repo . for a committable .cursor/hooks.json
# Hermes Agent (telemetry to governance; needs the CLI below, signed in; see harness/hermes/README.md)
hermes plugins install instruxi-io/agent-plugins/enforcer/harness/hermes --enable
# CLI (GitHub Packages: ~/.npmrc needs the two lines below)
# @instruxi-io:registry=https://npm.pkg.github.com
# //npm.pkg.github.com/:_authToken=<GitHub token with read:packages>
npm i -g @instruxi-io/enforcer
```

Then sign in with `/enforcer:login` (or `enforcer login`). See the repository README for details.

Under Cursor, use one way in: the plugin, or `enforcer harness install cursor` (user or `--repo`), not both. The installer refuses when the enforcer Cursor plugin, the other scope's hooks.json, or a hand-wired enforcer hook would also fire (`--force` installs anyway), and backs up an existing hooks.json before its first write. Should two hooks fire for one call anyway (including the Claude Code hooks Cursor imports), enforcer decides and meters it once and the others echo that answer. Cursor does not ask on a tool call, so a policy that would ask is a deny there, with a message that approval is required. Spend Cursor did not report reads `unmetered`, and models without a price `unpriced:<id>`, rather than $0 or an estimate.

Under OpenClaw, the Gateway keeps OpenClaw's own `diagnostics-otel` exporter pointed at Enforcer governance: metrics only (cost, tokens, model calls, tools, sessions; no traces, no log records, no prompt or response text), authenticated with a telemetry-only key minted for `openclaw@<host>` and written into `~/.openclaw/openclaw.json` (0600). It never touches a `diagnostics.otel` that points at another collector. `enforcer harness status openclaw` shows the state; `openclaw config set plugins.entries.enforcer.config.telemetry false` turns it off, as does disabling the agent in the Enforcer console. Sign in once with `enforcer login`, and the MCP server with `openclaw mcp login enforcer`.
