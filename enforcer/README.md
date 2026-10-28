# enforcer

Install with your harness's own plugin manager. Nothing is copied or shimmed.

```sh
# Claude Code
claude plugin marketplace add instruxi-io/agent-plugins && claude plugin install enforcer@instruxi
# Grok Build
grok plugin marketplace add instruxi-io/agent-plugins && grok plugin install enforcer --trust
# Codex (beta: hooks and skills load; the enforcer MCP sign-in under Codex is not working yet)
codex plugin marketplace add instruxi-io/agent-plugins && codex plugin add enforcer@instruxi
# Cursor (experimental: hooks only, from the CLI; or the plugin from .cursor-plugin/marketplace.json)
enforcer harness install cursor            # ~/.cursor/hooks.json; --repo . for a committable .cursor/hooks.json
# CLI (GitHub Packages: ~/.npmrc needs the two lines below)
# @instruxi-io:registry=https://npm.pkg.github.com
# //npm.pkg.github.com/:_authToken=<GitHub token with read:packages>
npm i -g @instruxi-io/enforcer
```

Then sign in with `/enforcer:login` (or `enforcer login`). See the repository README for details.

Under Cursor, use one way in: the plugin, or `enforcer harness install cursor` (user or `--repo`), not both. The installer refuses when the enforcer Cursor plugin, the other scope's hooks.json, or a hand-wired enforcer hook would also fire (`--force` installs anyway), and backs up an existing hooks.json before its first write. Should two hooks fire for one call anyway (including the Claude Code hooks Cursor imports), enforcer decides and meters it once and the others echo that answer. Cursor does not ask on a tool call, so a policy that would ask is a deny there, with a message that approval is required. Spend Cursor did not report reads `unmetered`, and models without a price `unpriced:<id>`, rather than $0 or an estimate.
