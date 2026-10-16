# WORKER_BRIEF: agent-plugins / the graph worker in `enforcer/`

Read this and the repo CLAUDE.md (if the repo has one) first, then only the files your node names.
Scope: the graph worker inside the `enforcer` plugin (skill, hooks, agent, dispatcher, tests). It is not a separate plugin: `enforcer-graph` is an empty deprecated alias in `aliases/`, and there is no plugin dependency.

## 1. Layout (paths relative to `enforcer/`)

- `plugin.json` (and `.claude-plugin/plugin.json`): name, `version`. One version for the whole kit; `npm run bump <version>` edits every manifest (see `docs/RELEASE_CHECKLIST.md` at the repo root).
- `skills/graph/SKILL.md`: the loop; "Writing a plan" is the node/brief format.
- `agents/graph-worker.md`: one-node worker, reads CLAUDE.md and this brief.
- `hooks/hooks.json`: wiring. Every event runs `node ${CLAUDE_PLUGIN_ROOT}/bin/enforcer event <name>` (`src/event.mjs`).
- `src/graph/hooks/`: the hook handlers (`attach`, `capture`, `heartbeat`, `session`, `track-run`, `version-check`, shared `common`). `src/graph/`: run file, state, http, redact, clip, evidence.
- `bin/land-pr.sh`: lands one PR, no model. `src/dispatch/*.mjs` (`enforcer dispatch`): keep N headless workers busy.
- `test/graph/*.test.mjs` (hooks against `test/graph/stub-graph.mjs`, a local fake API), `test/dispatch/`, `test/skill.test.mjs`.
- `docs/graph/settings.example.json`: allowlist forms. `docs/graph/README.md`: user docs; `DISPATCHER.md`: dispatcher flags.
- Run state: `$ENFORCER_STATE_DIR`, else the harness plugin data dir, else `~/.config/enforcer/sessions/<harness>` (`src/state.mjs`); `runs/<session>.json` and `evidence/<session>.jsonl` under it.
- Project config: `.enforcer/graph.json`, found by walking up from the cwd.

### Hooks (hooks/hooks.json)

All events call `bin/enforcer event <name>`; `src/event.mjs` routes to the handlers and they exit silently unless a graph context is live. The table of handlers is in `docs/graph/README.md` "Hooks". Heartbeat is by elapsed time (a third of the lease), not every Nth call.

## 2. Verify loop

```bash
cd enforcer && node --test test/graph/*.test.mjs > /tmp/r.log 2>&1; echo EXIT=$?; tail -12 /tmp/r.log
```
Whole suite: `cd enforcer && npm test`. No network, key, or Jev needed. Docs checks: `node --test test/docs-truth.test.mjs` from the repo root.

Land: open the PR (body ends with the Claude Code line), then from your worktree `enforcer/bin/land-pr.sh <pr> --timeout 3000`.
Exit 0 merged; 2 CI red; 3 conflict (rebase, read both sides); 4 timeout; 5 usage/gh error.

### Version bump
A change under `enforcer/` needs a `changes/<slug>.md` fragment (one line) or a version bump; CI's `version-bump` job checks.

## 3. Traps

- **Tool-name prefixes.** The graph tools load as `mcp__plugin_enforcer_enforcer__graph_*`. Standalone servers give `mcp__enforcer__` or `mcp__enforcer-graph__`. Allowlists must name the form your session shows; unmatched, every call prompts a human.
- **Hooks fire only on `graph_*` tools** for evidence, run tracking and the client stamp. Anything routed through `enforcer_api_write` is invisible to them and waits for a human; never heartbeat or report that way.
- **Plugin must be enabled.** `claude plugin enable enforcer@instruxi`. A disabled plugin = no hooks, and `graph_*` answers carry a `hooks_inactive` warning.
- **Headless (`claude -p`).** `graph_next_work`, `graph_heartbeat`, `graph_report` and `graph_remember` carry no `requiresUserInteraction`, so a headless worker can run the whole loop; other hosted write tools are refused. A worker denied a push/PR/tool is logged `DENIED <key> ... Worktree: <path>` and is not relaunched that session; land it by hand. A failed node is relaunched once as a REMEDIATION launch, then triaged once; see SKILL.md "When a node fails".
- **Evidence is merged by the hook.** Captured tool results of THIS run come first, then your own verbatim command/file/artifact records that are not duplicates; prose `note` records are dropped. Run the evidence commands as the LAST commands before reporting.
- **No loop check in the governor.** Repeated heartbeats and plan-status polls are never denied for repeating; `jev-hooks` owns loop detection. `loopOn`, `loopLimit` and `loopWindow` are retired settings.
- **Hooks fail open.** A hook swallows errors and prints nothing; a test that expects output must assert it, silence is not a pass.
- `hooks/hooks.json` is JSON: a trailing comma disables every hook with no error.

## 4. Where to look for X

- A matcher or event: `hooks/hooks.json`, `src/event.mjs`. Run-file shape: `src/graph/run.mjs`.
- Evidence rules: `docs/graph/README.md` ("A claimed pull request is resolved, not trusted"), then `src/graph/hooks/attach.mjs`.
- Dispatcher selection/model/tier rules: `src/dispatch/select.mjs`, `src/dispatch/model.mjs`.
- Plan-writing rules a test asserts: SKILL.md "Writing a plan" and `test/skill.test.mjs`.
- Adding a hook test: a `test('label', ...)` in the matching `test/graph/*.test.mjs`.

## 5. Never read whole

`grep -n '^#'` then a range for `skills/graph/SKILL.md` and `docs/graph/README.md`; grep the function in `src/graph/` and `src/dispatch/`.
