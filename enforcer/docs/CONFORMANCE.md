# Conformance: the graph every harness plugin must pass

`enforcer conformance --harnesses claude,codex,grok,gemini` files one graph per harness in
`instruxi-io/enforcer-smoke` (replacing that repo's `scripts/smoke-graph.py`) and prints the PROTOCOL
version it targets. Read the result with `enforcer conformance --status <graph>`: a pass/fail table.

Steps per harness: claim, heartbeat, check (the `repo.tests` runner check; the smoke repo carries a
`.enforcer/checks.json`), land (on the card's branch, fallback `graph/<key>` until claim-branch is rolled
out), report, verified. A harness that is not signed in fails its column at once with the reason.

Release rule: conformance must pass on claude before a release, and on every harness before a tag is
marked stable. The code is harness-neutral and lives in `src/conformance.mjs`.
