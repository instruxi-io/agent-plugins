# enforcer

Install with your harness's own plugin manager. Nothing is copied or shimmed.

```sh
# Claude Code
claude plugin marketplace add instruxi-io/agent-plugins && claude plugin install enforcer@instruxi
# Grok Build
grok plugin marketplace add instruxi-io/agent-plugins && grok plugin install enforcer --trust
# Codex
codex plugin marketplace add instruxi-io/agent-plugins && codex plugin add enforcer@instruxi
# CLI
npm i -g @instruxi/enforcer
```

Then sign in with `/enforcer:login` (or `enforcer login`). See the repository README for details.
