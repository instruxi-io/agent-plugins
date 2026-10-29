# Enforcer Governor

**A plugin for Claude Code, and for Codex and Grok Build, that reports what your agents spend and do, and keeps a record you can prove. Decisioning, the part that can refuse an action, is opt-in.**

Out of the box the governor **reports**: spend per agent, tools used, errors, and one receipt for every action it saw, in a hash-chained file on your machine that you can read with OpenTelemetry. It does not block anything until you turn Decisioning on. Until you sign in to an Enforcer workspace, everything stays on your machine, see [What leaves your machine](#what-leaves-your-machine).

- **Reporting (on)**: the status line, `governor status`, `governor report`, receipts.
- **Decisioning (off by default)**: capability rules, spend and rate checks, and your tenant policy, which answer *may this agent do this, right now?* with allow, rewrite, deny or ask. See [Decisioning](#decisioning-opt-in).

Loop detection is not the governor's job: `jev-hooks` owns it.

## Install

```
/plugin marketplace add instruxi-io/agent-plugins
/plugin install enforcer@instruxi
```

Since enforcer 1.0 the governor ships **inside** the `enforcer` plugin; there is no separate `enforcer-governor` plugin to install or disable. The `/enforcer-governor:*` slash commands named in older copies of this file are not registered by the `enforcer` plugin: use the `node bin/enforcer governor …` commands below (run from the plugin root, or ask for the governor skill), and the config file for everything else.

**Codex and Grok Build.** The same governor runs there; install steps are in the [plugin README](../../../README.md) (Codex CLI, Grok Build). Codex installs the plugin from the same marketplace and runs these hooks with `--harness codex`; its shims are tested on Codex-shaped input and have not yet been run against a live Codex. Grok Build is **experimental**: it installs the plugin natively (`grok plugin install enforcer --trust`) and runs the hooks from the plugin root, and its hook fixtures come from one grok 1.0.41 run. Under either, receipts and session registration name the harness actually running (`codex`, `grok-cli`), agent ids are `codex:<8>` and `grok:<8>`, and the spend limit reads that harness's own session log. **Cursor** is experimental: `hooks/cursor/shim.mjs` runs the same governor from Cursor's hooks (`enforcer harness install cursor`, or the Cursor plugin), receipts say `cursor`, agent ids are `cursor:<8>` (hooks only; Cursor's OpenTelemetry export is not wired yet). Cursor does not enforce `ask` on `preToolUse`, and documents no token usage, so a spend limit there counts only what the payload or transcript carries. The rest of this file is written for Claude Code; where a harness differs, it says so.

Then restart Claude Code and sign in once with `/enforcer:login`. The `enforcer` plugin is the connection to your Enforcer workspace (its MCP server and the sign-in); the governor works without it, reporting locally, but has no tenant policy to ask and nowhere to send receipts.

The governor brings the hooks that report and, when you enable them, decide. It cannot be disabled separately from the `enforcer` plugin (disabling `enforcer` also removes the graph hooks and the MCP server); decisioning is already off unless you turned it on, see [Turn decisioning on or off](#turn-decisioning-on-or-off). There is no daemon to start. The governor keeps its own state under `~/.config/enforcer/governor/` (moved from `~/.enforcer-governor/`, which now holds only a `MOVED_TO` marker) and a small shared file under `~/.enforcer/`.

Two pieces cannot arrive that way, because Claude Code does not let a plugin ship either one: a plugin's `settings.json` honours only the `agent` and `subagentStatusLine` keys, and everything else is ignored without a word. Both are a single paste into your own `~/.claude/settings.json`, and the governor reports correctly without either.

**The status line**, which is the only always-on surface, the number you glance at instead of opening something:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$(cat \"$HOME/.enforcer/plugin-root\")/statusline/spend.mjs\""
  }
}
```

The plugin's install directory changes with every version, so the status line does not name it: the governor records where it is running from in `~/.enforcer/plugin-root` at every session start, and the command follows that. Until the first session after installing, it prints nothing.

**The permission rules**, which are belt to the hooks' braces. Copy the `permissions` block from this repo's [`settings.json`](settings.json) into yours. The plugin cannot install it, so, once decisioning is on, without this paste the hooks are doing the work alone, see [How it works](#how-it-works) for exactly what that costs you, which is less than it sounds.

## What it reports

**`governor status` and `governor report`.** `node bin/enforcer governor status` shows spend per agent, limits, current burn, the state of the record, and in its first line whether Decisioning is on (`Decisioning: OFF (report only). Turn on: enforcer governor enable rules`). `node bin/enforcer governor report [--since 24h|7d|30d] [--json] [--verbose]` summarises spend, tools, errors and decisions from local cost files and receipts, per agent, project and model. It is offline and never prints command text. `--verbose` adds one section listing rule ids and tool names, nothing more.

**Receipts.** Every action the governor sees is one line appended to `~/.config/enforcer/governor/receipts.jsonl`, hash-chained: edit or delete a line and `node bin/enforcer governor verify` names the first line that does not add up. Each receipt carries who the agent acted for, the tool, the model, the spend, and, once decisioning is on, which rule decided. The format is a written contract: [`otel/receipt.schema.json`](otel/receipt.schema.json), checked by `test/receipt-schema.test.mjs`.

**OpenTelemetry.** [`otel/collector.yaml`](otel/collector.yaml) tails the receipts file with a `filelog` receiver, so any OpenTelemetry collector can ship it. [`otel/README.md`](otel/README.md) lists every field and how to run it (`otelcol-contrib --config otel/collector.yaml` from `enforcer/lib/governor`).

**A number in your status line, which is also where the money figure comes from.** `· $3.40/$20`, live spend against the limit, always visible, no dashboard to open. It changes colour once, when something needs you.

It has a second job. Claude Code hands its own `total_cost_usd` to the status line and **only** to the status line, the hooks never see it. That figure can be computed at an organisation's contracted rates, so it beats anything a third-party price table can know. The status line records it and the gate reads it back on the next tool call. Without the paste in [Install](#install) the governor still reports; it just meters from the transcript instead, and every receipt says which of the two answered.


## Decisioning (opt-in)

**Decisioning is off by default.** With it off, nothing here refuses, rewrites or asks: the hook answers allow with the code `checks_off` and the receipt says so. It is three independent checks, each off until configured:

| Check | Setting | What it does |
|---|---|---|
| capability rules | `rulesOn` | what an agent may do: pipes to a shell, deletes, force-pushes, secrets, deploys, graph worker delivery |
| spend and rate checks | `budgetOn` | per-agent dollar limits, burn, fan-out and retry rates |
| tenant policy lookup | `policyOn` | ask your Enforcer policy about a rule that matched |

**Capability rules that ship with the plugin.** Piping a URL into a shell is refused outright. Deleting a tree, rewriting git history, reading credentials, publishing or deploying: those stop and ask. These are capability decisions, not spend ones, so they fire on a full budget, and they are checked without reading any state at all, so they hold even when the governor cannot read its own files. Deleting the state directory turns off the spend limit; it does not turn off the rules.

**Your organisation's policy, not just ours.** Sign in once with `/enforcer:login` and the rules above stop being the same six patterns for everyone. When a rule matches, the governor asks your Enforcer tenant policy about it: a resource of type `agent_action` whose id names the rule (`fs.delete_tree`, `deploy.publish`, `git.force_push`, `git.rewrite_history`, `secrets.access`, `shell.pipe_to_shell`). The policy is Rego, versioned, tested before it can go live, and rolled back by activating the previous version, so "agents here never delete a whole tree" or "publishing needs a person" is one change for the whole team.

Its answer composes with the local rule, and the direction matters:

| | local deny | local ask | local rewrite |
|---|---|---|---|
| **policy deny** | deny | deny, in the policy's words | deny |
| **policy `ask:` reason** | deny | ask, in the policy's words | ask |
| **policy allow** | deny | no objection | rewrite |
| **no rule / unreachable** | deny | ask | rewrite |

A policy can make anything stricter and can waive a confirmation. It cannot lift a hard deny (`curl | sh` stays refused), and it cannot skip a rewrite. If Enforcer is slow, down, or you are signed out, the local rule decides alone, so losing the network never allows more. Only a matched command is asked about; ordinary tool calls never wait on the network. Answers are reused for `policyTtlSec` (30s), which is also how quickly a new policy version reaches each machine.

```rego
declared_types := ["agent_action"]

allow if { input.resource_type == "agent_action" }   # declared, so silence would deny

deny contains "agents in this tenant do not delete whole directory trees" if {
	input.resource_type == "agent_action"
	input.resource.id == "fs.delete_tree"
}

deny contains "ask: publishing from an agent needs a person to confirm" if {
	input.resource_type == "agent_action"
	input.resource.id == "deploy.publish"
}
```

**One sign-in for the governor and the Enforcer MCP server.** The MCP server comes with the `enforcer` plugin from the same marketplace (`/plugin install enforcer@instruxi`), not with the governor; until 2.6.0 the governor shipped its own copy. Both read the same credential, `~/.enforcer/credentials.json` (0600), so one `/enforcer:login` signs both in, and signing out stops both sending a credential.

**A spend limit that means dollars.** `node bin/enforcer governor limit 40` sets $40 per agent. Claude prices each model at its own rate, so $40 is $40 whether the agent is on Opus 5 or Haiku 4.5. Under Grok Build the figure is Grok's own per-turn cost, and under Codex it is Codex's cumulative token counts priced at each turn's model. Where the harness figure is unavailable the cap falls back to cost-weighted effective tokens, because cached sessions re-read their whole context every turn and raw token counts explode while costing very little.

**A word to the agent, not just to you.** An agent that learns it is near the limit can land what it has instead of opening a new front. At roughly two thirds of the budget it is told once, one sentence, at the turn boundary, where it can still change its plan, and then the governor goes quiet until the situation changes. Warning at the limit itself is too late: the turn is already committed. Every word costs, because it joins the cached prefix and is billed on every later turn, which is why it is one sentence and why it is said once.

**A safer command instead of a refused one.** Some actions have a form that keeps the intent and drops the footgun. `git push --force` becomes `git push --force-with-lease`, which refuses only when someone else has pushed since your last fetch, the case that loses work. The rewrite is announced and recorded; a governor that edits commands silently would be an invisible actor in your transcript.

**Rate limits, not just totals.** The incidents that cost real money are rate incidents. Dollars per minute, new agents per minute, and errors per minute are each watched and each *ask* rather than block, and ask once, so an overnight run waits for you instead of dying or nagging.

**A record an audit can read.** `node bin/enforcer governor verify` walks the file, names every break and counts the lines that still chain. It also fails when lines are missing from the end: when the last line is not the head `state.json` recorded, when the file no longer holds the newest receipt the control plane acknowledged (kept in `outbox.json` once you are signed in; this one still shows after the governor has carried on and `state.json` has caught up with the shortened file), or when `receipts.jsonl` is gone while either still names a head. A last line with no hash is a break, even one marked as a blind-path refusal (`chained: false`): an honest one stops being the last line at the next decision, and one whose hash was removed looks the same until then. What it cannot see from this machine alone is a file truncated together with `state.json` and `outbox.json` deleted or rewritten, or the newest receipts cut before they were ever shipped: everything it checks against lives here. The receipts shipped to the server are the only external anchor. Every receipt carries who the agent acted for, what it tried, which model answered, and which rule decided.

Receipts are hashed in one of two ways, and a record may hold both. **v1**, `sha256(prev + JSON.stringify(receipt))`, is what every receipt used before hash v2, and what the governor writes until your workspace says it understands v2; only JavaScript can reproduce it reliably. **v2** (`"hv": 2` in the receipt) is `sha256("enforcer-receipt/v2\n" + prev + "\n" + JCS(receipt))`, where JCS is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON, so any language can recompute it from the receipt's value (`core/chain.mjs`; the test vectors in `test/fixtures/jcs-vectors.json` are shared with the control plane). The governor switches to v2 once your workspace's receipt ingest answers with `Enforcer-Receipt-Hash-Versions: 1,2`, and back to v1 if an answer stops saying so; a machine that never signs in keeps writing v1.

## Commands

Run from the plugin root:

| | |
|---|---|
| `node bin/enforcer governor status` | whether decisioning is on, spend per agent, limits, current burn, state of the record |
| `node bin/enforcer governor report [--since 24h\|7d\|30d] [--json] [--verbose]` | spend, tools, errors and decisions from local data |
| `node bin/enforcer governor verify` | check the chain, names every break, counts the lines that still chain, and says when lines are missing from the end |
| `node bin/enforcer governor config [--why]` | every setting, what it does, and which you have changed |
| `node bin/enforcer governor enable <rules\|budget\|policy>` | turn a decisioning check on (`disable` turns it off) |
| `node bin/enforcer governor set <name> <value>` | change a validated setting, such as `shadow` |
| `node bin/enforcer governor limit <dollars>` | set the per-agent limit |
| `node bin/enforcer governor telemetry [on\|off\|status]` | Claude Code's own OpenTelemetry export (default off) |
| `node bin/enforcer governor telemetry codex [on\|off\|status]` | Codex's own OpenTelemetry export (default on; `off` removes it and keeps it off) |
| `/enforcer:login [<WORKSPACE-CODE> \| api-key <key> \| status \| logout]` | sign in to Enforcer; no argument opens a browser, a workspace code skips asking for it |

`resume` (run a stopped agent again) is not exposed in the `enforcer` plugin today. The same commands are available as `/enforcer:governor`.

### Turn decisioning on or off

Decisioning is off until you enable it. To turn the capability rules on:

```
node bin/enforcer governor enable rules
```

`enable` and `disable` take `rules`, `budget` or `policy`, which set `rulesOn`, `budgetOn` and `policyOn` in `~/.config/enforcer/governor/config.json` (that file also holds your other settings, so the commands change keys in place). `node bin/enforcer governor set <name> <value>` changes any other setting and refuses a value the validator rejects. The checks are independent: `rulesOn` alone leaves spend unmetered, and `budgetOn` alone leaves `curl | sh` unguarded. An agent stopped for **spending** is freed by raising the limit (`node bin/enforcer governor limit 40`) and carries on from where it stopped. One you stopped yourself needs `resume`, which is not exposed here. Do not delete `state.json` to unstick something: it holds the head of the receipt chain, so the next receipt hashes against nothing and `verify` correctly reports the record as broken.

**Per process.** `ENFORCER_GOVERNOR_RULES`, `ENFORCER_GOVERNOR_BUDGET` and `ENFORCER_GOVERNOR_POLICY` scope `rulesOn`, `budgetOn` and `policyOn` to one process and its children without touching `config.json`. `on` always applies: it beats a `config.json` that says off. `off` applies only when your own `config.json` sets `allowEnvOff: true` (`enforcer governor set allowEnvOff true`); without it an environment `off` is ignored, because a project's `.claude/settings.json` can set environment variables for every session opened in it, and a repository must not be able to switch your rules off by being opened. `allowEnvOff` is read only from `config.json` at the fixed per-user path (`~/.config/enforcer/governor/config.json`), never from the environment, a project file, or a `config.json` that `GOVERNOR_HOME` or `ENFORCER_CONFIG_HOME` points at. Any value other than `on` or `off` (`true`, `1`, `yes`, empty) is ignored. An ignored `off` and an unrecognised value each print one stderr notice per process naming the variable, and `governor status` and `governor config` show them. None of these beat your organisation's policy: a managed `on` still wins. `governor config` marks an applied value with `~` and `governor status` names the variables.

**Dispatcher workers.** `enforcer dispatch <graph> --worker-rules on|off` says whether the graph workers it starts run with the capability rules on (it sets `ENFORCER_GOVERNOR_RULES` for them). `off` takes effect only with `allowEnvOff` in `config.json`; without it workers follow `config.json`. The default is off, and the dispatcher's preflight states the mode.

**Shadow mode.** With `rulesOn` off and `shadow` on (the default), the capability rules are still evaluated locally and each receipt records what they would have decided as `would: {decision, code, rule}`, while the hook answers allow with `checks_off`. So you can see what turning decisioning on would do before you do it. Shadow mode never asks the tenant policy, never reads spend, does not run the graph-worker rules, and an error in it only drops `would`. With `rulesOn` on there is no `would`: the real decision is the receipt. Run `node bin/enforcer governor set shadow false` to stop recording it.

**Your organisation's policy is a floor.** Whatever you set locally, an organisation that turns a check `on` keeps it on (see below).

### Settings your organisation sets

An Enforcer tenant can publish a set of these settings for every install it signs in (`GET /api/v1/governance/settings`, written by a tenant admin). They are a **floor, not an override**: for each setting the governor applies whichever of the two is stricter, so a managed $150 beats your $400 and your $40 beats both, and a check the organisation turns on (`rulesOn`, `budgetOn` or `policyOn`) cannot be turned off locally: an organisation `on` still beats a local `off`, and an organisation can therefore turn decisioning on for every install it signs in. `node bin/enforcer governor config` marks them with `!` and shows your own value beside them.

Nothing waits on the network to decide: the settings are fetched at session start, at most hourly, and cached. A machine that is signed out, or has never reached the control plane, runs on its own config alone. Identity settings (`centralUrl`, `ingestUrl`, `operator`) cannot be managed, being able to repoint an install is being able to redirect its receipts.

## What leaves your machine

Nothing, until you sign in. The governor decides and records locally, and a machine that has never signed in (`/enforcer:login`) makes no network calls at all: the session-start version and tool check skips its health fetch when there is no credential. Everything the governor writes (`~/.config/enforcer` and the governor directory 0700, its files 0600) is private to you, and existing files are tightened on start.

Once you sign in to an Enforcer workspace, these can leave, each under a switch:

| what | when | switch |
|---|---|---|
| **Decision receipts**, the verdict, the rule that fired, the tool name, the model, token counts, a project name derived from the working directory, the `operator` (the `operator` setting if you set one, otherwise the email of the account you are signed in as), and which harness decided (`claude-code`, `codex` or `grok-cli`) with its adapter version. A session's summary receipt also carries its measured token counts (`usage`: input, output, cache read, cache write, and Grok's reasoning tokens) beside the dollar figure, so governance can read the session's size without trusting a price table. Never the command text, never file contents, never prompts. | shipped in the background to your workspace's governance API whenever you are signed in | `shipOn` (default on). Your organisation's managed settings can force it on, and a managed `on` beats a local `off`, so the local switch may not stop it |
| **A session's project**, at session start, the session id the receipts use (`claude:`, `codex:` or `grok:` + 8 characters), the project name derived from the working directory, and the harness running the session with its full session id. The project files the session even if it never makes a governed decision; the harness and session id register the session, so governance can match its receipts and telemetry to it (provenance level 2, *registered*; level 3, *corroborated*, once both name it). Nothing else. | once per session start, one short request, never retried | `shipOn` (default on), same managed floor |
| **Your organisation's policy answers**, for an action a local rule matched, the governor asks your workspace whether to allow, ask or deny. The request names the rule, not the command. | only when a rule matches, and only if you turned `policyOn` on (default off) | `policyOn` (default off) |
| **Claude Code's own telemetry** (Claude Code only), cost, tokens and tool-use metrics from Claude Code's built-in OpenTelemetry exporter. Prompt text and tool parameters are not exported: `telemetry on` removes `OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_TOOL_DETAILS` from Claude Code's settings if they are there, and `telemetry status` warns when they are. | only if you turn it on | `telemetry on` (default off; `enforcer governor telemetry on`) |
| **Codex's own telemetry** (Codex only), its `codex.*` events and metrics (tokens, tool calls, timings) from Codex's built-in OpenTelemetry exporter, sent to governance instead of Codex's default metrics sink (OpenAI's statsig); traces off. Authenticated with a per-machine Codex ingest key that can only write telemetry, written to `$CODEX_HOME/config.toml` (`~/.codex/config.toml`), which is kept 0600; only the `[otel]` keys it owns are touched. Prompt text, agent responses and tool output are not exported (`log_user_prompt`, `log_agent_responses`, `log_guardian_assessments` forced false, `tool_result.max_bytes = 0`); tool **arguments** are, because Codex 0.164 has no switch for them. | written at each Codex session start and at sign-in when the Enforcer plugin is installed in Codex; Codex picks up a changed key at its next start | `telemetry codex off` (sets `codexTelemetry` off and removes the keys) |

Everything goes to the workspace you signed in to and nowhere else. `/enforcer:login logout` stops all of them on this machine; what has already been sent stays in your workspace's records, which is the point of a record.

Files the governor writes: `~/.config/enforcer/governor/` (config, state, the receipt chain, per-session scratch that is swept after `sweepDays`), `~/.enforcer/credentials.json` (your sign-in) and `~/.enforcer/plugin-root` (where the installed plugin lives, so telemetry stays signed in across plugin updates).

## Decisions and their codes

Every decision the governor makes, including "no objection", is one JSON record:

```json
{"decision":"deny","code":"push_not_alone","rule":"graph.push","tool":"Bash","summary":"a push, pull request or land must be the whole command, on its own","run_id":"a54645af-…"}
```

- `decision` is `allow`, `deny` or `ask` (a rewrite is put to the person as an `ask` carrying the safer command).
- `code` is one of the codes below, defined once in `core/codes.mjs`. Codes are a published vocabulary: they are added, never renamed or reused.
- `rule` is the rule's policy id (`git.force_push`), or `null` when no rule decided.
- `run_id` is present only when the session holds an enforcer-graph run (`ENFORCER_GRAPH_RUN_ID`, or the run file enforcer-graph's hooks keep).

`graph_decide` (decide a graph node, the capability of `graph_review`'s approve) is classified as a write by the rule `enforcer.graph_decide`: it asks a person, and a headless worker is denied. It reports as `custom_rule`.

The record is written three places: as the `decision` field, last, on the hash-chained receipt in `~/.config/enforcer/governor/receipts.jsonl`; as one line on the PreToolUse hook's stderr, prefixed `enforcer-governor:decision `; and, in a session nobody is watching (headless), as the **first line** of the permission reason whenever the hook allows, denies or asks. With a person present the reason is only the plain sentence, so the Allow dialog never shows JSON. A parent process (the graph dispatcher, a CI wrapper) parses that line instead of grepping the sentence under it.

| Code | Meaning |
|---|---|
| `pipe_to_shell` | a script piped from curl/wget into a shell |
| `force_push` | a force-push (--force, -f or a +refspec) |
| `destructive_delete` | rm -rf of a whole tree |
| `destructive_git` | history rewrite: reset --hard or filter-branch |
| `secret_in_command` | the action reads or writes a credentials file (.env, keys, credentials.json, ~/.aws, ~/.ssh): a shell command on such a path, or an edit whose target is one, a mention in text, a report or a fixture is not access (1.0.3) |
| `deploy_publish` | publish or deploy (npm publish, vercel --prod, kubectl apply/delete, terraform apply) |
| `custom_rule` | a rule from config.json with no code of its own |
| `graph_push_allowed` | headless worker pushing its own graph/<key> branch, as the whole command |
| `graph_pr_allowed` | headless worker opening a pull request from its graph/<key> branch |
| `graph_land_allowed` | headless worker landing its graph/<key> pull request with land-pr.sh |
| `worktree_delete_allowed` | headless worker deleting a tree inside its own worktree (`rm -rf dist`); outside it, the worktree itself or `.git` keep the capability ask |
| `graph_push_confirm` | graph/<key> push from a session with a person present: they confirm |
| `graph_pr_confirm` | pull request from a graph/<key> branch in a session with a person present |
| `graph_land_confirm` | land-pr.sh in a session with a person present |
| `push_not_alone` | a push, pull request or land chained with other commands; it must run on its own |
| `push_default_branch` | a push to a default branch (main, master, develop, trunk) |
| `push_needs_approval_surface` | a push or pull request no rule allows, in a session with nobody to ask |
| `branch_mismatch` | pushing a branch other than the one the worktree has checked out |
| `outside_worktree` | the working directory is not a git worktree on a graph/<key> branch |
| `delivery_shape` | a headless worker ran a delivery command (push, remote, pull request create/merge, api, land-pr.sh) that is not exactly a recognised shape |
| `settings_write` | an edit to plugin or governor settings |
| `protected_path` | a headless worker changing `.github/`, release or deploy scripts, or secret files (a release node, marked by the dispatcher, may) |
| `tenant_policy` | the organisation's Enforcer policy decided |
| `agent_stopped` | the agent was stopped by a person, and stays stopped until resumed |
| `ask_declined` | the agent was paused to ask you something and the answer was not yes; it stays denied until resumed or the day rolls |
| `period_limit` | the daily, weekly or monthly spend limit is reached |
| `burn_rate` | spending faster than the per-minute mark |
| `fanout_rate` | starting subagents faster than the fan-out mark |
| `retry_storm` | failing and retrying faster than the retry mark |
| `client_limit` | a client's spend limit is reached |
| `spend_limit` | the agent's spend limit is reached |
| `spend_warning` | the agent passed the warn-me mark of its spend limit |
| `no_rule_matched` | no rule objected and spend is within limits |
| `spend_unchecked` | no rule objected; the governor could not read its state, so spend was not checked |
| `checks_off` | no rule objected; decision checks are switched off |

### Headless graph workers

A graph worker is a `claude -p` session the dispatcher starts in a git worktree on branch `graph/<key>`, with nobody to answer a prompt. The governor is the plugin that allows or denies its delivery steps (`core/worker.mjs`); jev-hooks and enforcer-graph no longer decide them. A session is **headless** when `JEV_HOOKS_HEADLESS=1` or `ENFORCER_HEADLESS=1` is set, or Claude Code reports the `sdk-cli` entrypoint (`claude -p`). The branch is read from the `.git` of the directory the command runs in (`cwd`, or `git -C <dir>`).

| Rule | Headless | A person is present |
|---|---|---|
| `graph.push`: `git push -u origin graph/<key>` as the whole command, on that branch (also `HEAD:graph/<key>`, and `--force-with-lease` for the rebase path) | **allow** `graph_push_allowed`; chained: deny `push_not_alone`; other branch: deny `branch_mismatch`; not a graph worktree: deny `outside_worktree`; any other push: deny `push_needs_approval_surface` | ask `graph_push_confirm` |
| `graph.pr_create`: `gh pr create` from the graph branch | **allow** `graph_pr_allowed`; off a graph branch: deny `outside_worktree` | ask `graph_pr_confirm` |
| `graph.land`: `land-pr.sh`, including the skill's `"$(ls -d …/land-pr.sh \| tail -1)"` form | **allow** `graph_land_allowed`; off a graph branch: deny `outside_worktree` | ask `graph_land_confirm` |
| `git.force_push`: `--force`, `-f`, `+refspec` | deny `force_push` | rewritten to `--force-with-lease` (an ask) `force_push` |
| `git.push_default_branch`: a push to `main`, `master`, `develop` or `trunk` | deny `push_default_branch` | ask `push_default_branch` |
| `governor.settings`: an edit of `.claude/settings*.json`, `managed-settings.json`, `.claude/plugins/`, `~/.config/enforcer/governor/` or the legacy `~/.enforcer-governor/` (Edit/Write, or a shell command that writes) | deny `settings_write` | ask `settings_write` |
| `graph.protected_paths`: Edit/Write or a shell write to `.github/`, release/deploy/publish scripts, `.env`, keys, `.npmrc` | deny `protected_path` | not applied |

These are the only rules that **allow** (an affirmative grant that skips the prompt). They run before the capability rules, a tenant policy can still refuse what they allow, and `rulesOn: false` turns them off with the rest.

## How it works

```
prompt  ─► UserPromptSubmit ─► a word to the agent, if the situation changed

                         ┌─ capability rules ─── only if rulesOn, no state, FAILS CLOSED
                         │     └─ matched? ask your tenant policy (only if policyOn)
tool call ─► PreToolUse ─┤         unreachable leaves the local rule in place
                         └─ spend + rate ─────── only if budgetOn, needs state, FAILS OPEN
                                   │
                                   ▼
        decisioning off: allow (checks_off, `would` in shadow mode)
        decisioning on:  allow / deny / ask / rewrite
                                   │
                                   ▼
                      hash-chained receipt, always written

result  ─► PostToolUse ─► what actually happened (errors feed the retry-rate check)
subagent─► SubagentStart ─► fan-out, counted rather than inferred
```

Seven hooks, no daemon, no port, nothing listening. State lives in `~/.config/enforcer/governor/` behind a lock, so parallel tool calls land in the record in the order they were decided.

That split is the architecture, and the two halves fail in opposite directions on purpose. **Spend fails open**: if the state is unreadable the hook allows the action and says in the reason line that it did not check, because a governor that blocks real work over a missing file of its own has failed at something more important than enforcing. **Capability fails closed**, because it can afford to, the rules are patterns matched against the action text and need no state, so an unreadable state directory does not reach them. A refusal decided that way is still written to the record, deliberately without a hash: there is no readable chain tail to hash against, and `verify` counts an unhashed line as unverifiable rather than as a break once a chained decision follows it (as the last line it is reported, since a stripped hash looks the same). Recording nothing would hide a real refusal, and forging a link would cry tampering on an honest file.

The same direction holds for the configuration. A missing `config.json` is a fresh install, so the defaults apply and decisioning is off; a `config.json` that exists but cannot be read or parsed keeps `rulesOn` on (one stderr notice per process) while spend keeps failing open, and the `governor.home` rule asks before `chmod`, `mv`, `rm` or `ln` against the governor's directory. The organisation floor's cache, `managed-settings.json`, sits at the fixed per-user `~/.config/enforcer/governor/` whatever `GOVERNOR_HOME` or `ENFORCER_CONFIG_HOME` say, and a different `ENFORCER_API_KEY` keeps the last floor until a refresh with the new credential succeeds.

The transcript is read forward from where the last call stopped, so the cost of checking does not grow with the length of your session.

## Run the tests

```
npm test
```

## The bigger picture

The Governor is one idea applied to one resource. The idea is **Enforcer**, Instruxi's policy engine, and it asks a single question in front of every system it guards: *may this identity do this, right now?*, answered three ways, with a tamper-evident receipt for every answer. Here that identity is an AI agent and the resource is your money. **[instruxi.io](https://instruxi.io)**

## License

Functional Source License 1.1 (FSL-1.1-ALv2). Free to run on your own agents, in production, including commercially. You may not offer it as a competing commercial product or service. Becomes Apache 2.0 two years after each release. See [LICENSE](LICENSE).

## State growth

`state.json` is read, parsed and rewritten on every hook call, so it is kept small. Each agent entry is stamped with `lastSeen` when touched; on load, agents idle longer than `sweepDays` (default 7, 0 keeps forever) are dropped, except an escalated agent or one with a pending ask. An entry with no `lastSeen` (an older file) is stamped, not dropped. `unmapped` keeps its 100 most recent folders. The cursor and cost scratch files are swept from PreToolUse at most once a day (`sweptAt` in state) as well as at SessionStart. Measure with `node scripts/bench-hook.mjs --populated`.
