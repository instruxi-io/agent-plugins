# Known issues and limits

What we know is imperfect, stated plainly. Last reviewed 2026-10-11, against plugin 1.3.6, enforcer-graph 4d2d106 and enforcer-v3-mcp 3116406.

## Security and data

- **Governor decisioning is off by default.** It records and reports; it only
  blocks once you turn rules on. Since 1.3.1 an unreadable config fails closed
  (rules stay on) and the organisation floor cannot be redirected away; an
  environment `off` is honoured only when the user opts in (`allowEnvOff`).
- **Worker credentials.** Dispatched workers act as a named agent account with
  its own expiring key. A worker's environment holds that key for the length of
  its run; a SIGKILL can leave a key file behind in the state directory until the
  next prune. Workers share the operator's `HOME`; per-worker home isolation was
  rejected because copying Claude's single-use refresh token would sign the
  operator out.
- **Telemetry.** Off unless enabled. When enabled it can include tool-call
  metadata; review the collector config before turning it on.
- **Judge billing outages.** A TypeSafe billing failure is named (`billing`),
  retried every 10 minutes without spending attempts, and pages via the
  `JudgmentBillingBlocked` alert (live since 2026-10-10). Auto-reload is not
  set; the alert is the safety net.
- **Secrets scanning.** One-time scans of about 17,000 commits across seven
  repositories found no live secrets. There is no continuous scanner yet.

## Platform

- **Windows.** MCP, files, the governor and the graph hooks work. `enforcer
  dispatch` is POSIX only (use WSL).
- **Go toolchain.** Both Go services build on Go 1.26.9 with `govulncheck`
  reporting no reachable vulnerabilities (as of 2026-10-10). The service
  pins the exact patch in CI, so the next Go advisory needs a deliberate bump.
- **Graph import.** Fixed 2026-10-09: a document whose nodes share resources no
  longer reports a false `edge_would_create_cycle`; chain edges follow the
  `requires` order. A truly cyclic document is still rejected.
- **MCP tool list after reconnect.** Agent tools can be missing from the list
  after `/mcp` reconnects until the session restarts.
- **Judge rejections.** Measured over 657 runs: 37% of rejections were later
  overruled by a person, almost always because an acceptance line could not be
  run (prose instead of a command, an unresolved `<n>`). Since 1.3.2 the
  evidence runner resolves the pull request and `plan check` flags unrunnable
  lines before dispatch; a replay of those 102 runs showed no judge-policy
  change rescues them, so the policy and thresholds are unchanged. Near the
  1.50 score floor the judge still flips about 1 run in 24.
- **Context pack and recall.** Shipped in 1.3.6 and off by default per graph.
  Plumbing is verified end to end; the first A/B on four-node graphs measured
  no token saving (the comparison was confounded by unequal tasks). Three paired deep-node runs (identical audit
  chains, same model both sides, pack and recall on versus off) measured no
  reliable saving: turns changed -20%, +2% and -1%, cache reads -31%, +4% and
  -13%, with 12 of 12 verdicts unchanged. The first pair's figure did not
  replicate and is not claimed (docs/CONTEXT_BASELINE.md in enforcer-graph).
- **Hook latency.** 1.3.3 trimmed the pre-tool-use hook's startup by a few
  milliseconds on an empty home; on a home with a long receipts history the
  hook still costs about 100 ms per tool call. The tail-read fix is not done.
- **Sign-in scopes.** A plain OAuth sign-in does not see `graph_review`,
  `graph_share`, `graph_unshare`, `graph_lifecycle` or `agent_groups`; the owner
  API key does. Attended mode's `resolve` may need the key until the default
  grant is widened.

## Process

- **Dependencies.** Dependabot and SHA-pinned actions are in place on
  claude-plugins, enforcer-graph-demos, gvnr-site and enforcer-v3-portal (since
  2026-10-09). Branch protection blocks force-push and deletion everywhere;
  required human review is still not enabled.
- **jev-hooks** is a separate, community project (MIT) that needs your own
  TypeSafe key. Whether distributing a client driven by users' own keys fits
  TypeSafe's agreement is still unconfirmed with them.
- **Licence.** FSL-1.1-ALv2; no lawyer has reviewed the choice yet.
