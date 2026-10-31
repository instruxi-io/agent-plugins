# Governor receipts and the OpenTelemetry collector

`collector.yaml` reads the governor's receipts file with a `filelog` receiver, so the format of one receipt line is an interface. `receipt.schema.json` is that interface, written down; `test/receipt-schema.test.mjs` checks that every kind of receipt the governor writes validates against it, and that every field the collector references exists in it.

## Run the collector

```
otelcol-contrib --config otel/collector.yaml
```

Run it from `enforcer/lib/governor`. `filelog` and `kafka` are in the contrib distribution, not core. The collector tails the receipts file and never rotates or rewrites it. Set `KAFKA_BROKERS` for the Kafka exporter, or use the `debug` exporter to see lines while you get started. The path in `collector.yaml` (`include`) must point at the governor's `receipts.jsonl`; edit it if your state directory is not the default.

## One line, one receipt

Each line is a JSON object, appended, never rewritten. Only `ts`, `agent` and `verdict` are always present; everything else is omitted when it has no value.

| Field | Meaning |
|---|---|
| `ts` | ISO 8601 UTC time with milliseconds. The collector uses it as the log timestamp. |
| `agent` | The agent id. |
| `verdict` | `allow`, `deny`, `ask`, `rewrite`, `escalate`, or `summary` (the session-end line). The collector maps it to a severity. |
| `reason` | A sentence for a person. The collector deletes it. |
| `source` | Which check answered: capability, economics, policy or worker. |
| `rule` | The name of the capability rule that fired. |
| `rewrote` | `true` when the tool input was rewritten. |
| `tool` | The harness's tool name, such as `Bash`. |
| `model` | The model the agent was priced at. |
| `tokens` | Tokens the agent had spent at decision time. |
| `operator` | Who the agent acted for. |
| `client` | The project the working directory maps to. |
| `meter` | Where the spend figure came from. |
| `spent_usd`, `cost_usd` | Dollars spent when decided, and the session total on `summary` lines. |
| `unchecked` | `true` when the answer was given without reading the books. |
| `chained` | `false` on a line written without a hash (the blind path). |
| `policy` | What the tenant policy said, when it was asked. |
| `harness`, `adapter_version` | Which harness asked, and its adapter version. |
| `graph_id` | The graph a worker run belongs to. |
| `data_classification`, `purpose`, `legal_basis`, `retention_class` | The operator's compliance settings (`/enforcer:governor set purpose ...`); absent when unset. |
| `policy_id`, `policy_version` | The local ruleset whose rule decided, and a sha256 of its rules; absent when spend or the tenant's policy decided. |
| `decision` | `{decision, code, rule, tool, summary, run_id?}`: the machine-readable decision. `code` comes from `core/codes.mjs`; `rule` is the rule id, such as `fs.delete_tree`. |
| `would` | `{decision, code, rule}`: what the capability rules would have decided while they are off (shadow mode). Absent when they are on. |
| `hash` | sha256 of the previous hash plus this line's JSON without `hash`. Absent on an unhashed line. |

Additions go at the end of a line and unknown keys are allowed, so a reader must ignore fields it does not know. Existing fields are not renamed.

## What receipts never contain

Receipts never contain prompts, model output, tool input or command text. They name the tool (`Bash`) and the rule that fired, not what was typed. The test asserts the schema has no field for them.
