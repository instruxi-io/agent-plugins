# Known issues and limits

What we know is imperfect, stated plainly. Last reviewed 2026-10-12, against plugin 1.3.10, enforcer-graph 2b3757b and enforcer-v3-mcp a3c26e7.

## Security and data

- **Governor decisioning is off by default.** It records and reports; it only
  blocks once you turn rules on. Since 1.3.1 an unreadable config fails closed
  (rules stay on) and the organisation floor cannot be redirected away; an
  environment `off` is honoured only when the user opts in (`allowEnvOff`).
- **Worker credentials.** Dispatched workers act as a named agent account with
  its own expiring key. A worker's environment holds that key for the length of
  its run; a SIGKILL can leave a key file behind in the state directory until the
  next prune. Since 1.3.9 a worker's `ENFORCER_HOME` is an empty per-run
  directory, so the operator's sign-in file is not visible to it (it keeps
  `HOME` for ordinary tools); a failed token mint no longer falls back to the
  full agent key, and minted tokens are revoked when the worker exits.
- **Repository files cannot redirect credentials.** Until 1.3.9 a cloned repo's
  `.enforcer/graph.json` could name any host and any environment variable as
  the key, and the hooks would send that variable there on session start. A
  repo file's `api_key_env` is now honoured only for `ENFORCER_*` or `GRAPH_*`
  names and its `base_url` only for the configured enforcer host or localhost;
  anything else is ignored with a notice.
- **Acceptance lines stay inside the checkout.** Until 1.3.9 the allow-list
  accepted `grep -R`, which follows symlinks out of the tree, and `plan check`
  took `data.repo` unvalidated. Both are closed. Also fixed in 1.3.9: the
  `gh pr view` acceptance shape had been dead since 1.3.2 (the isolated
  environment stripped `GH_TOKEN`), so the judge had been shown a failing `gh`
  record for every pull-request line; it now passes the operator's token
  through read-only, or skips the line and says so.
- **Compaction summaries are redacted.** Until 1.3.9 the text a session
  remembered on compaction went to graph memory unredacted; it now passes the
  same redaction as evidence.
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
- **Switching sign-ins.** `/enforcer:login` as a different account or workspace
  updates the hooks and the `enforcer` CLI at once, but the MCP tool server keeps
  the previous session: Claude Code runs the headers helper only before connecting
  and after a 401. Login revokes the old access token so the next call re-runs the
  helper (1.3.10); if the tools still show the old identity, run `/mcp`, pick
  enforcer and reconnect (or restart Claude Code).
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
  replicate and is not claimed. A third test on 2026-10-12 (one identical
  100-turn audit node, three arms, two reps each) found pack and recall cost
  MORE than control on a single long node, and the dispatcher's
  `--autocompact 100000` halved wall time and cut cache reads 40-60% without
  cutting cost, while the judge's confidence in the result dropped. All of it
  is in docs/CONTEXT_BASELINE.md in enforcer-graph; every feature stays off by
  default.
- **Hook latency.** Fixed in 1.3.8. The cause was not the receipts file (it was
  always tail-read) but `state.json`: 725 agent entries never evicted, 90% of
  it the retired loop detector's history, read, parsed and rewritten on every
  call (2.05 MB on a four-week home). State is now bounded (0.25 MB after one
  call on the same home) and the per-agent history field is gone. Measured
  overhead over a bare node start: 60 ms before, 42 ms after; 1.3.9 took the
  post-tool-use fast path from 52 ms to 32 ms. Eviction never drops an agent a
  person has grounded, paused or given a raised budget, and the organisation
  floor is served stale rather than expiring after a day offline (both 1.3.9).
- **Gate runs and echo evidence.** A `gate` node's run can still be accepted by
  the judge on evidence that is only an `echo` of the decision. Gates are meant
  for people: use `graph_decide` or `graphwatch decide` rather than reporting a
  gate as a worker.
- **Stale rejected-verdict items.** When a rejected run is retried and the
  retry is verified, the first attempt's `verdict_rejected` item stays in the
  review queue until someone accepts it; it is informational and parks nothing.
- **Sign-in scopes.** A plain OAuth sign-in does not see `graph_review`,
  `graph_share`, `graph_unshare`, `graph_lifecycle` or `agent_groups`; the owner
  API key does. Attended mode's `resolve` may need the key until the default
  grant is widened.

## Process

- **Dependencies.** Dependabot and SHA-pinned actions are in place on
  agent-plugins (was claude-plugins), graphwatch (was enforcer-graph-demos), gvnr-site and enforcer-v3-portal (since
  2026-10-09). The pinned-action bumps to checkout 7.0.1 and setup-node 7.0.0
  merged 2026-10-12; the TypeScript 7 bump is open with failing checks. Branch
  protection blocks force-push and deletion everywhere; required human review
  is still not enabled.
- **jev-hooks** is a separate, community project (MIT) that needs your own
  TypeSafe key. Whether distributing a client driven by users' own keys fits
  TypeSafe's agreement is still unconfirmed with them.
- **Licence.** FSL-1.1-ALv2; no lawyer has reviewed the choice yet.
