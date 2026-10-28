# Per-tier routes: harness, model and endpoint per tier (design)

Status: implemented for claude. Items 1-3 and 6 are in `src/dispatch/routes.mjs`, `routeFor` in `src/dispatch/model.mjs` and `test/dispatch/routes.test.mjs`: the table, its sources and validation, precedence, the probe and fallback, and the preflight and status lines. Item 4 is in `endpointEnv` / `workerEnv` in `src/dispatch/launch.mjs` with `test/dispatch/endpoint-env.test.mjs`: the worker environment for a claude endpoint. The codex and grok endpoint forms are not built; validation refuses them. The paragraph below describes the dispatcher before routes.

Today one dispatcher run has one harness and each node has one model:

- the harness is fixed per run by `--harness` (`src/dispatch/run.mjs` reads `this.args.harness || 'claude'` when it builds the agent MCP config (~340), when it reaps a worker (~568) and when it shuts down (~706); `src/dispatch/launch.mjs` `HARNESS_CAPS` says what each harness can do and `launchCmd` builds its command line);
- the model is chosen per node by `modelFor` in `src/dispatch/model.mjs` (`data.model`, then a user tier through `TIER_MODEL`, then `--model`, then the tier, then sonnet);
- every worker talks to its harness's default provider; there is no way to point a tier at a self-hosted endpoint.

A **route** binds a tier to a harness, a model and optionally an endpoint, so one dispatcher run can send mechanical nodes to a local model under one harness and deep nodes to Opus under Claude Code. The sections below are numbered as the node that asked for this design numbers them.

## 1. The route table

### Shape

```json
{
  "version": 1,
  "routes": {
    "mechanical": { "harness": "codex",  "model": "Qwen3.8-27B", "endpoint": { "url": "http://gpu1:8000", "api": "openai", "token_env": "VLLM_TOKEN" }, "fallback": "route:standard" },
    "standard":   { "harness": "claude", "model": "Qwen3.8-27B", "endpoint": { "url": "http://gpu1:8001", "api": "anthropic", "token_env": "VLLM_TOKEN" }, "fallback": "wait" },
    "deep":       { "harness": "claude", "model": "opus" },
    "untiered":   { "harness": "claude", "model": "sonnet" }
  }
}
```

One entry per tier key: `mechanical`, `standard`, `deep`, and `untiered` (a node with no `data.tier`, or a tier that is not one of the three). Every entry is optional; a tier with no entry has no route and falls through the precedence in section 2.

| field | required | meaning |
|---|---|---|
| `harness` | no (default: the run's `--harness`, else `claude`) | one of `HARNESSES` (`claude`, `codex`, `grok`, and `gemini` once it has a launcher and a stream parser) |
| `model` | no (default: section 2) | the model name passed to the harness. With an endpoint, the name the endpoint serves (`/v1/models` id); without one, a name the harness knows (`harnessKnowsModel`) |
| `endpoint.url` | with `endpoint` | base URL, `http` or `https`, no path past the API root (no trailing `/v1`) |
| `endpoint.api` | with `endpoint` | `anthropic` (Messages API: `/v1/messages`) or `openai` (Chat Completions / Responses: `/v1/chat/completions`) |
| `endpoint.token_env` | no | the NAME of the environment variable holding the endpoint's bearer token. Never the token itself |
| `fallback` | no (default `wait`) | what to do when the endpoint is down; section 3 |

### Where it lives

Resolved in this order; the first one found is the whole table (tables are not merged key by key, so what runs is always one readable file):

1. `--routes FILE` on `enforcer dispatch run` (and `start`, which passes it through);
2. the graph's `node_defaults.routes` (the same object as `routes` above), so a plan can carry its own routing the way it carries `bases`;
3. `<config home>/dispatch/routes.json`, the same directory as `repo-bases.json`: `$ENFORCER_CONFIG_HOME/dispatch/routes.json`, else `~/.config/enforcer/dispatch/routes.json`. CONFIG.md gains a row for it and for the new variable `ENFORCER_ROUTES` (a path, equivalent to `--routes`, between steps 1 and 2);
4. none: no routes, today's behaviour exactly.

`--no-routes` ignores every source (step 4), for a run that must behave as today.

### Validation

The table is validated once at startup, before the lease is taken; any error is a usage error (exit 5) naming the source and the field, never a silent fallback (CONFIG.md's rule). Errors:

- `routes: <source>: not valid JSON: <parser message>`
- `routes: <source>: version must be 1`
- `routes.<tier>: unknown tier (expected mechanical, standard, deep, untiered)`
- `routes.<tier>.<field>: unknown field` (typos such as `modle` are caught, not ignored)
- `routes.<tier>.harness: must be one of claude, codex, grok`
- `routes.<tier>.harness: <harnessRefusal message>` (an unsupported harness, or an experimental one without `--experimental`)
- `routes.<tier>.model: <model> is not a <harness> model` (no endpoint and `harnessKnowsModel` is false)
- `routes.<tier>.endpoint.url: must be an http(s) URL without a path past the root`
- `routes.<tier>.endpoint.api: must be anthropic or openai`
- `routes.<tier>.endpoint.api: <harness> cannot speak <api>` (see the matrix in section 4: e.g. codex with `anthropic`)
- `routes.<tier>.endpoint.token_env: <NAME> is not set` (set but empty also counts as not set)
- `routes.<tier>.endpoint.token_env: must be a variable name, not a token` (a value that matches the redactor's token shapes, or contains characters other than `[A-Z0-9_]`)
- `routes.<tier>.fallback: must be wait or route:<tier|harness>`
- `routes.<tier>.fallback: route:<x> forms a cycle (<a> -> <b> -> <a>)` or `points at a route that itself has a down endpoint and no fallback`

## 2. Precedence

For each node the dispatcher resolves harness, model and endpoint separately, each by the first rule that gives a value:

| | harness | model | endpoint |
|---|---|---|---|
| 1 | node `data.harness` | node `data.model` (or the claim card's `model`) | the route's, only when the route also gave the harness |
| 2 | the route for the node's tier | the route for the node's tier | none |
| 3 | `--harness` | `--model` | |
| 4 | `claude` | `TIER_MODEL[tier]`, else `sonnet` | |

Rules that keep this predictable:

- **A route is chosen by tier**, with `untiered` for no tier. The tier is the node's `data.tier` whatever its `tier_source`.
- **An endpoint never outlives its harness.** If `data.harness` names a harness other than the route's, the route's endpoint and model are dropped (a Qwen-on-vLLM model name means nothing to the provider of another harness); the node runs on that harness with `data.model`, else `--model`, else the default.
- **`--model` still caps.** Today `--model` caps a node's model unless the tier was set by a person (`tier_source: user`). With routes: `--model` caps every route model that does NOT carry an endpoint and is ranked above the cap (`opus` > `sonnet` > `haiku`; names outside that ladder are not ranked and are not capped). A route model behind an endpoint is never capped: it is not a hosted-provider spend. A `tier_source: user` tier is still exempt from the cap, so a person's `deep` stays on the deep route's model. `data.model` is never capped (as today).
- **`--harness` is now a default, not a law**: it applies to tiers with no route and no `data.harness`. Preflight prints when a route overrides it (section 6).
- `modelFor(node, override)` becomes `routeFor(node, routes, args)` returning `{tier, harness, model, endpoint, source}` where `source` names which rule gave each field (`node`, `route:<tier>`, `flag`, `default`). The launch line and pids.json carry it.

## 3. Endpoint down: probe and fallback

### Probe

Before launching a node on a route with an endpoint, the dispatcher probes `GET <url>/v1/models` with the route's token (as `Authorization: Bearer` for `openai`, `x-api-key` and `Authorization: Bearer` for `anthropic`), timeout 5 s. The endpoint is **up** when the answer is 200, is JSON, and lists the route's `model` among `data[].id`. Otherwise it is **down**, with a reason: `unreachable (<errno>)`, `HTTP <status>`, `not JSON`, or `model <m> not served (serves: <ids, first 5>)`.

A probe result is cached per endpoint URL for `--route-probe-ttl` seconds (default 60): workers launched on a busy pass do not each probe. A worker that exits with a connection error to the endpoint (the summarize step sees one in the stream) clears the cache entry, so the next launch probes again.

### Fallback

Per route, `fallback` says what a down endpoint does to a node that wants it:

- `wait` (default): the node is not launched this pass and spends no attempt. The dispatcher logs `route <tier>: endpoint <url> down (<reason>); holding <keys>` once per 10 minutes and keeps polling at `--interval`. A run whose only remaining work is held on a down endpoint does not exit as "nothing runnable"; it waits, as it waits on verdicts (`--exit-when-idle` restores the exit).
- `route:<tier>`: launch the node on that tier's route instead (`route:deep`, `route:standard`, `route:untiered`), probing it in turn if it has an endpoint. Chains are followed, cycles are refused at validation.
- `route:<harness>`: launch on that harness with no endpoint and the model from precedence rules 3 and 4 (`route:claude` = "use Claude's own provider, `--model` or the tier default").

A fallback launch is logged `launch <key> ... route=<tier>->fallback:<target> (endpoint down: <reason>)` and recorded in pids.json (section 5), so the summary and the report show the node did not run where its route said. `--model` caps a fallback model by the same rule as section 2 (a fallback to the hosted provider is capped; to another endpoint, not).

## 4. Worker environment per harness

The endpoint changes only the worker's environment and, where a harness has no environment form, a config file in the worker's state dir. The token is read by the dispatcher from `process.env[token_env]` and handed to the worker as an environment variable; it is never in argv (argv is visible in `ps` and in the launch log), never written to a file in the worktree, and it is passed to `addSecret` (`src/dispatch/logs.mjs`) so it is replaced with `[redacted:secret]` in `dispatcher.jsonl` and in every worker stream (`redactFile` on exit). `token_env` itself is NOT added to `ENV_ALLOW`: the dispatcher sets the target variable from it explicitly per worker, so an operator's other tokens still never pass.

Which harness speaks which `api`:

| harness | `anthropic` | `openai` |
|---|---|---|
| claude | yes (native) | no: front it with LiteLLM, or use vLLM's Anthropic-compatible endpoint |
| codex | no | yes (custom model provider) |
| grok | no | yes, if the CLI accepts a base URL; otherwise refused at validation |
| gemini | no | only through an OpenAI-compatible base URL the CLI accepts; refused until the launcher exists |

### Claude Code (`api: anthropic`)

Set:

- `ANTHROPIC_BASE_URL=<url>`
- `ANTHROPIC_AUTH_TOKEN=<token>` (sent as `Authorization: Bearer`); when the route has no `token_env`, a fixed placeholder such as `none` so Claude Code does not fall back to the operator's login
- the model aliases, all to the route's model, so whatever alias the agent file, a subagent or a fallback asks for lands on the endpoint and not on Anthropic: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`; and `--model <route model>` on the command line
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (no telemetry or update calls leaving for Anthropic from a local run)

Drop, even though `ENV_ALLOW` passes them today: `CLAUDE_CODE_OAUTH_TOKEN` (it would win over the base URL for auth and bill the operator's subscription), `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` (either would route away from the base URL), and any inherited `ANTHROPIC_API_KEY`. A Claude worker on a route WITHOUT an endpoint keeps today's environment exactly.

### Codex (`api: openai`)

Codex reads providers from its config, not from flags alone. The dispatcher writes `<state>/codex-<key>/config.toml` (mode 0600, removed when the worker exits, like `mcp-<key>.json`) and launches with `CODEX_HOME=<state>/codex-<key>`:

```toml
model = "Qwen3.8-27B"
model_provider = "route"

[model_providers.route]
name = "route mechanical"
base_url = "http://gpu1:8000/v1"
env_key = "ENFORCER_ROUTE_TOKEN"
wire_api = "chat"
```

The token goes in the environment as `ENFORCER_ROUTE_TOKEN` (the file names the variable, never the value). `OPENAI_API_KEY` and `OPENAI_BASE_URL` are not passed. `HARNESS_CAPS.codex` must first become `supported: true` (the stream parser it lacks today); until then a route naming codex is refused at validation with the existing `harnessRefusal` message.

### Grok

When the Grok CLI accepts an OpenAI-compatible base URL, set it from the route (`GROK_BASE_URL=<url>/v1` and its key variable from the token), drop any inherited xAI key, and pass `--model <route model>` without the `harnessKnowsModel` prefix check (an endpoint model is trusted to the probe, not to the prefix list). If the CLI has no such setting, a grok route with an endpoint is a validation error: `routes.<tier>.endpoint: grok cannot use a custom endpoint`.

### Gemini

Gemini is not in `HARNESSES` today. Adding it needs a launcher in `launchCmd`, a stream parser in `summarize`, and `HARNESS_CAPS.gemini`. Its endpoint form, when added, follows the same rules: base URL and key from the route in the environment, the operator's Google credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_API_KEY`) not passed. Until then `gemini` is refused at validation.

## 5. What pids.json records

Today `pids.json` holds `{dispatcher, dispatcherStart, host, workers: {key: pid}, meta: {key: {start, nonce}}}`, and reap, summarize and shutdown read the run's single `--harness`. With routes each worker may run a different harness, so `meta` gains the route as launched:

```json
"meta": {
  "fix-typo": {
    "start": "123456", "nonce": "…",
    "harness": "codex", "model": "Qwen3.8-27B", "tier": "mechanical",
    "route": "mechanical", "fallback_from": null,
    "endpoint": "http://gpu1:8000", "api": "openai",
    "session": "…", "log": "logs/fix-typo.1.jsonl"
  }
}
```

The token and `token_env` are never recorded. Every reader uses the worker's own record:

- **reap** (`run.mjs` ~568): `countTurns(w.logPath, w.harness)`, `summarize(w.logPath, w.harness)` and the compaction count (Claude only) take the worker's harness, not `this.args.harness`.
- **shutdown** (~706) and the startup orphan sweep: the same, per worker; an orphan whose record has no `harness` (written by an older dispatcher) is read as `claude`.
- **agent MCP config** (~340): written only for a worker whose resolved harness is `claude`.
- **resume / warm sessions**: a warm session is keyed by `(data.repo, harness, model, endpoint url)`, not `(data.repo, model)`, so a session started against vLLM is never resumed against Anthropic or under a different harness.
- **dispatch status** and **prune** read `harness`, `model` and `route` from the record for their lines.

## 6. Preflight and `enforcer dispatch status`

### Preflight

After the existing `worker-plugin`, `worker-rules` and `identity` lines, preflight prints the table it will use and its source, one line per tier, with the probe result:

```
routes      from ~/.config/enforcer/dispatch/routes.json
route       mechanical  codex  Qwen3.8-27B  openai http://gpu1:8000 (token VLLM_TOKEN)  up        fallback route:standard
route       standard    claude Qwen3.8-27B  anthropic http://gpu1:8001 (token VLLM_TOKEN) DOWN: HTTP 502  fallback wait
route       deep        claude opus         provider                                    -         (--model sonnet does not cap: user tier) 
route       untiered    claude sonnet       provider (default)
route-note  --harness grok is overridden by routes for mechanical, standard, deep
route-plan  12 nodes: mechanical 5, standard 4, deep 2, untiered 1
```

`routes  none (today's behaviour: --harness claude, TIER_MODEL)` when there is no table. A down endpoint at preflight is a warning, not a refusal: the run starts and the fallback applies. A table error is printed and the run exits 5 (section 1).

### `enforcer dispatch status`

Each running worker line gains its route: `running fix-typo  codex Qwen3.8-27B @gpu1:8000 (mechanical)  12 turns  4m`, and a fallback shows as `(mechanical -> standard: endpoint down)`. Below the workers, one line per endpoint the last probe saw: `endpoint http://gpu1:8001 DOWN since 18:02 (HTTP 502); holding 3 nodes: a, b, c` so the person reading it knows the plan is waiting on their GPU box, not on the graph.

## Worked example

A GPU box `gpu1` runs vLLM serving `Qwen3.8-27B` twice: port 8000 with the OpenAI API, port 8001 with vLLM's Anthropic Messages endpoint (or LiteLLM on 8001 translating to port 8000). Both accept the token in `VLLM_TOKEN`.

`~/.config/enforcer/dispatch/routes.json`:

```json
{
  "version": 1,
  "routes": {
    "mechanical": {
      "harness": "codex",
      "model": "Qwen3.8-27B",
      "endpoint": { "url": "http://gpu1:8000", "api": "openai", "token_env": "VLLM_TOKEN" },
      "fallback": "route:standard"
    },
    "standard": {
      "harness": "claude",
      "model": "Qwen3.8-27B",
      "endpoint": { "url": "http://gpu1:8001", "api": "anthropic", "token_env": "VLLM_TOKEN" },
      "fallback": "route:claude"
    },
    "deep": { "harness": "claude", "model": "opus" }
  }
}
```

Run: `VLLM_TOKEN=… enforcer dispatch run <graph> --workers 4 --model sonnet`.

- A `mechanical` node: probe `http://gpu1:8000/v1/models` lists `Qwen3.8-27B`, so the worker is `codex exec --json --model Qwen3.8-27B <prompt>` with `CODEX_HOME=<state>/codex-<key>` (the provider block above) and `ENFORCER_ROUTE_TOKEN` set from `VLLM_TOKEN`. Not capped by `--model sonnet`: it has an endpoint.
- A `standard` node: `claude -p … --model Qwen3.8-27B` with `ANTHROPIC_BASE_URL=http://gpu1:8001`, `ANTHROPIC_AUTH_TOKEN=<VLLM_TOKEN>`, every `ANTHROPIC_DEFAULT_*_MODEL` set to `Qwen3.8-27B`, and no `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock or Vertex variable.
- A `deep` node: `claude -p … --model sonnet` — `--model sonnet` caps the route's `opus` because it has no endpoint — unless the node's tier is `tier_source: user`, in which case `--model opus`, exactly as today. Environment unchanged from today.
- An untiered node: no `untiered` route, so `--harness` (claude) and `--model sonnet`.
- If port 8000 goes down: mechanical nodes fall to `route:standard` (Claude against port 8001, probed in turn); if 8001 is also down, `route:claude` sends them to Anthropic with `--model sonnet`. Each such launch is logged with `fallback_from` and shown in `dispatch status`.
- `pids.json` records `harness: codex` for the mechanical workers and `claude` for the rest; a reap reads each worker's stream with its own parser.
