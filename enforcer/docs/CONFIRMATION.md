# Confirmation: deny writes nothing, approval writes the approved call

This document is the portable contract for a remote Enforcer MCP connector. The checks that enforce it live in `enforcer/test/confirmation/`. They do not open a Cursor window, a Grok Bot session, or a socket to the MCP server.

## What the harness proves

`enforcer/test/confirmation/contract.mjs` is a host-side gate. The suite feeds it the locked tool list (`enforcer/lib/api/spec/mcp-manifest.json`, the `mcp` entry in `spec.lock.json`: `enforcer-v3-mcp` `tool-names.json`) and the fixtures in `enforcer/test/fixtures/confirmation/`.

For one intended call:

- **deny** or **cancel** does not dispatch. A `workspace_switch` that is denied or cancelled leaves `preferred_tenant_id` unset.
- **approve** dispatches once, and the dispatched name and arguments are the ones that were approved. A different tool or a different argument is not dispatched.
- A missing decision dispatches only when the tool is a pure read, or one of the five intentional unconfirmed writes below. Every other tool waits.
- `ask` and the hook word `allow` are not approvals. Nothing is dispatched.
- Each approval is one call. A second approval is a second call.

The gate decides from MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`), the five-name exception list, and the known-side-effect pin. It does not read `_meta["anthropic/requiresUserInteraction"]`. Setting or removing that flag does not change the decision. That flag is the signal Claude Code uses for a headless session; it is not a portable confirmation.

## The five intentional unconfirmed writes

These writes are allowed to run with no prompt. The list is pinned in `enforcer/test/fixtures/confirmation/pin.json` and checked against every tool in the locked manifest. They are the only mutations with that exemption. A deny or cancel of one of them still dispatches nothing.

| Tool | Why it is unconfirmed |
|---|---|
| `graph_next_work` | Work-loop claim. A headless worker has to take the node without a person at the keyboard. |
| `graph_heartbeat` | Lease refresh on that claim. |
| `graph_report` | The worker's own completion report. |
| `graph_remember` | A note the worker writes while the loop is running. |
| `update_task` | Task-loop update, same asynchronous policy as the graph loop. |

`enforcer_api_write` and every tool whose effect is `destructive` stay confirmed. A new write that is not one of the five fails the suite until it is added to the pin on purpose.

## `workspace_switch` is not a pure read

The OAuth path persists `preferred_tenant_id` through `updateMyPerson`. The pin records that side effect. The gate therefore requires confirmation, including when the locked manifest still classifies the tool as `effect: "read"`.

The annotation builder described in the catalog assessment turns that classification into `readOnlyHint: true` and `idempotentHint: true`, and it attaches no confirmation metadata. The suite treats that advertisement as a **mis-advertised read**: the tool is still not a pure read, and a deny, cancel, or missing decision does not persist a tenant. When the advertisement says otherwise (`readOnlyHint: false`), the same gate still requires confirmation. A sibling change on `enforcer-v3-mcp` can correct the classification; this suite does not need that change merged first, and it does not start treating the tool as a read when the hints change.

The suite cannot see side effects that the pin does not name. A future tool that writes while advertising `readOnlyHint: true` needs a `knownSideEffects` entry or the harness will trust the advertisement.

## Hook versus a bare remote connector

Two different surfaces ship in this repo.

**Local plugin hooks.** `enforcer/.cursor-plugin/plugin.json` points `hooks` at `enforcer/hooks/cursor/hooks.json`, which runs `hooks/cursor/shim.mjs`. On `preToolUse` the shim turns a governor `ask` into `permission: "deny"` and drops any rewritten input, because Cursor runs an `ask` answer instead of showing a prompt. `failClosed` is set. The same translation is what `enforcer/test/cursor-shim.test.mjs` covers. Grok Build has its own local shim under `hooks/grok/`. Those hooks run on the machine where the plugin is installed. They are a governor, and they are not an MCP confirmation dialog.

**Bare remote connector.** `enforcer/mcp.json` is only `type: streamable-http` and `https://api.instruxi.dev/mcp`. It has no `command` and no `hooks`. A client that adds that URL and does not install the Cursor plugin does not load the shim. The Claude entry (`.mcp.json`) is a different config (`type: http` plus `headersHelper`) and is not the Cursor connector.

The confirmation harness does not import the shim or the governor. Computing the shim's deny answer does not dispatch a tool. Installing the plugin does not, by itself, prove that a bare remote connection asked a person.

Server dispatch does not check an approval receipt. The gate above is the host's job. This repo does not add a receipt check on the server.

## What is still UNVERIFIED

These tests do not show any of the following. Do not read a green run as evidence for them.

- A native Cursor desktop or web/Agents approval dialog: cancel, deny, and approve, including Run Mode and allowlists that can skip the prompt.
- A Grok Bot remote-connector confirmation. The Grok Build CLI plugin and its local hooks are a different surface.
- A live `tools/list` from `https://api.instruxi.dev/mcp`, or the private `enforcer-v3-mcp` source. This environment received HTTP 404 for that repository. The catalog assessment read `src/tools.ts` at `91ed740b8b8141c66deabf54ec1ba6d6c7341f30` and described the hint builder there. The hints in this suite are derived from each locked tool's `effect` (`read` → read-only and idempotent, `destructive` → `destructiveHint`, otherwise a write). They are not a captured tools/list payload, and they do not include fields the assessment did not name.
- That the deployed server's classification of `workspace_switch` matches a corrected write. The locked manifest is the input. Today that entry is `effect: "read"`, and the suite reports the resulting read-only hint as a mis-advertisement.
- OAuth, DCR, tenant consent, and deployment identity. Those are outside this contract.

When `tool-names.json` is re-pinned, the suite reads the new `spec.lock.json` ref and classifies whatever effect is locked. The five names and the `workspace_switch` side effect stay pinned until someone changes `pin.json` and the test that repeats those names.
