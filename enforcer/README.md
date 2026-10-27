# enforcer

Install with your harness's own plugin manager. Nothing is copied or shimmed.

```sh
# Claude Code
claude plugin marketplace add instruxi-io/agent-plugins && claude plugin install enforcer@instruxi
# Grok Build
grok plugin marketplace add instruxi-io/agent-plugins && grok plugin install enforcer --trust
# Codex (beta: hooks and skills load; the enforcer MCP sign-in under Codex is not working yet)
codex plugin marketplace add instruxi-io/agent-plugins && codex plugin add enforcer@instruxi
# CLI (GitHub Packages: ~/.npmrc needs the two lines below)
# @instruxi-io:registry=https://npm.pkg.github.com
# //npm.pkg.github.com/:_authToken=<GitHub token with read:packages>
npm i -g @instruxi-io/enforcer
```

Then sign in with `/enforcer:login` (or `enforcer login`). See the repository README for details.
