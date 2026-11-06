# Enforcer on Cursor

Onboarding for the Cursor plugin in this package (`enforcer/.cursor-plugin/plugin.json`, `enforcer/mcp.json`, `enforcer/skills/`). It is the usage and configuration guide for a marketplace listing. This change does not submit the plugin to the marketplace and does not merge it.

The shipped Cursor server entry is URL-only. It declares no `${VAR}` placeholder and no static OAuth client id. Cursor's rule "declare every `${VAR}`" is met because there is nothing to declare. A secret does not belong in this repo.

Two facts from Engineering's source read and live probe on 2026-11-05 are used below and marked as such. Anything this repo cannot prove is marked **UNVERIFIED, pending Engineering (CR-4)** or **pending Engineering (CR-3)**.

## Install in Cursor

The Cursor plugin ships skills, the MCP server, and `hooks/cursor/hooks.json`. It does not ship the Claude slash commands or the graph-worker agent: `.cursor-plugin/plugin.json` sets `commands` and `agents` to empty arrays, which turns off folder discovery for those components. Those files remain for Claude Code.

Use one install, not both. The plugin's hooks and `enforcer harness install cursor` (user `~/.cursor/hooks.json`, or `--repo` for a cloud agent's `.cursor/hooks.json`) would each fire. The installer refuses when the other is already present.

Marketplace install, once a reviewed listing exists: open Customize, install **Enforcer**, and choose user or project scope. This repository does not publish that listing.

Local check, from Cursor's plugin docs: copy this `enforcer/` directory to `~/.cursor/plugins/local/enforcer` so `.cursor-plugin/plugin.json` is inside the copy, reload the window, and confirm the skills, the `enforcer` MCP server, and the hooks in Customize. Symlinks that point outside that folder are not loaded. **UNVERIFIED, pending Engineering (CR-4):** this change did not run that GUI install, and Cursor's documented manifest fields do not list `displayName`. That field is already in the manifest and was left in place.

`hooks/cursor/hooks.json` uses `${CURSOR_PLUGIN_ROOT}`, which Cursor expands to the plugin install path. It is not a user-configured plugin variable and is not declared under `variables`.

## Generic MCP clients

The server URL is `https://api.instruxi.dev/mcp` (streamable HTTP). A client that only needs the URL can use the same entry the plugin ships:

```json
{
  "mcpServers": {
    "enforcer": {
      "type": "streamable-http",
      "url": "https://api.instruxi.dev/mcp"
    }
  }
}
```

This repo authenticates its own API calls with `X-API-Key` when the credential is an API key, and with `Authorization: Bearer` when it is an OAuth access token (`src/credentials.mjs`). A generic client that cannot run OAuth can send `X-API-Key` from its own environment. Do not write the key into a file that gets committed. Do not use a shell-style `$ENFORCER_API_KEY` in a Cursor plugin file. Cursor substitutes `${ENFORCER_API_KEY}` only when that name is a property of `variables` in `.cursor-plugin/plugin.json`. This package does not add that header or that variable.

Claude Code is a different file. `enforcer/.mcp.json` runs `bin/enforcer-headers.mjs`, which prints those headers from `~/.enforcer/credentials.json`. The Cursor plugin does not run that helper.

## Authentication

Two paths exist in this package. They are not the same session.

### Browser sign-in and API key (CLI)

`enforcer login` (and `/enforcer:login` on Claude Code) is implemented in `bin/login.mjs`.

- Browser sign-in is OAuth 2.1 with authorization code and PKCE S256. The CLI registers a public client (dynamic client registration), opens the authorize URL, catches the loopback redirect, and stores the refresh token in `~/.enforcer/credentials.json`.
- `enforcer login api-key` reads an existing key from a file or stdin, never from an argument.
- Presets: `--for work` (default), `plan`, `agents`, or `admin`. `--scope` asks for a named list. A name the server does not offer is refused before the browser opens.
- `enforcer login scopes` lists what discovery advertises. `enforcer login status` shows the account. `enforcer login logout` deletes the local credential.

Engineering's probe on 2026-11-05, for the hosted issuer `https://api.instruxi.dev`:

- Discovery is `/.well-known/oauth-authorization-server`.
- Grants: `authorization_code`, `refresh_token`, token-exchange, `client_credentials`.
- Authorize: `/api/v1/enforcer/oauth/authorize`
- Token: `/api/v1/enforcer/oauth/token`
- Dynamic client registration: `/api/v1/enforcer/oauth/register`
- JWKS: `/.well-known/jwks.json`
- `resource_indicators` and `client_id_metadata_document` are supported.
- The authorization server advertises 69 scopes (`enforcer:read`, `policy:self`, `enforcer:*.write`, and `.destructive`).

`mcp.json` has no static client id, so a client that does OAuth has to use discovery and dynamic client registration. That matches the CLI.

### Native Cursor OAuth

**UNVERIFIED, pending Engineering (CR-4).** `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` returned 404 on 2026-11-05. This package therefore does not claim that Cursor completes OAuth, which scopes that grant includes, or that Cursor's callback URL is on the allow-list. Do not treat the 69 advertised scopes as usable from Cursor. Tool access is still filtered by the server's profile.

The CLI sign-in is what the governor hooks read. It does not, by itself, attach a header to the Cursor MCP connection, because `mcp.json` has no headers.

## Scopes and least privilege

A role is the account's ceiling. A scope is narrower than the role. An OAuth sign-in and a scoped API key carry only the scopes they were granted. The skill model for an unscoped API key is that it carries the account's whole role (`skills/enforcer/SKILL.md`). The server profile is a third filter on which MCP tools are offered. Which profile a given role receives is **UNVERIFIED, pending Engineering (CR-4)**.

The CLI presets in `bin/login.mjs` are what a browser sign-in requests. They are not a statement about a Cursor grant.

| Preset | Requests |
|---|---|
| `work` (default) | `enforcer:read`, `policy:self`, `enforcer:graph-runs.write`, `enforcer:graph-observations.write`, `enforcer:graph-nodes.write`, `enforcer:graph-edges.write`, `enforcer:files-files.write`, `enforcer:workspace.write` when offered, `enforcer:agents.write`, `enforcer:agents-credentials.write`, and, when offered, `enforcer:graph-sharing.write`, `enforcer:graph-work.write`, `enforcer:graph-skills.write` |
| `plan` | `work` plus `enforcer:graph-graphs.write`, `enforcer:graph-graph-templates.write`, `enforcer:graph-epochs.write` |
| `agents` | `enforcer:read`, `policy:self`, `enforcer:agents.write`, `enforcer:agents-credentials.write`, and the same three sharing scopes when offered |
| `admin` | every scope discovery offers |

`work`, `plan`, and `agents` do not request `.destructive` scopes. `admin` does, when the server offers them. The CLI drops a sign-in whose token is too large for the server (HTTP 431) and does not replace a working credential. That has happened with `admin`. Prefer `work`, or `--scope` with the few names the task needs. The checked-in fixture `test/fixtures/offered-scopes.json` lists 45 scope names. It is not the live list of 69.

Least privilege for a person connecting an agent:

- Use `work` unless the task is authoring plans (`plan`) or only managing agents (`agents`).
- Do not put a platform-admin credential (the `cross_tenant` grant) on an agent. The pinned v3 spec says a platform admin's writes on another tenant's agents are the suspend path and the kill switch; other cross-tenant agent writes are refused `platform_admin_read_only`.
- Issue `agent_credential_issue` only when a person needs a key. The secret is shown once. Do not write it to a file or repeat it.
- Prefer a scoped key over an unscoped one.
- `graph_reset` and review resolution are writes. They are not part of the default work loop's "ask later" story. See Write safety.

## Who can do what

Built-in role slugs in the pinned v3 spec are `admin`, `tenant_admin`, `developer`, and `user`. The spec uses "platform admin" and "system admin" for a caller whose grant includes `cross_tenant`. Permission flags on a role are `tenant_read`, `tenant_write`, `tenant_manage`, `cross_tenant`, and `admin_managed`. Custom roles exist, so a slug is not the grant. Read the grants with `enforcer_whoami` before guessing.

The table is only what the pinned `enforcer/lib/api/spec/v3.json` route descriptions say. It is not an MCP tool matrix. **UNVERIFIED, pending Engineering (CR-4):** which of the workflow tools a user, a tenant_admin, or a platform admin is offered.

| What the pinned spec says | `user` | `developer` | `tenant_admin` | Platform admin (`cross_tenant`; built-in slug `admin` where the spec says so) |
|---|---|---|---|---|
| Account list | Only themselves | Own tenant | Own tenant | All tenants |
| Another account's contacts | Not listed. The route requires `tenant_read`, which the ticket route calls "developer and up" | Own tenant | Own tenant | Named as admin. A foreign-tenant id is 404 for tenant-scoped callers. Cross-tenant behavior for a `cross_tenant` caller is not spelled out on this route |
| Connections and SSO lists | None | None | Own tenant | Own tenant by default; another tenant with `tenant_id`, or every tenant with `all_tenants=true` |
| Tenant directory | None | None | Own tenant | Own tenant by default; `all_tenants=true` or `tenant_id` for the rest |
| Tenant join code | Stripped | Stripped | Present for their tenant | Present |
| Admin audit trail | Nothing (own actions are `GET /me/audit-events`) | Nothing on that route ("everyone else") | Own tenant only | Own tenant by default; another tenant or all tenants with the query flags |
| Create or delete a custom role | No (platform-only) | No | No | Yes. Built-in slugs cannot be deleted or rewritten |
| Another tenant's agents | Not stated as a cross-tenant writer | Not stated as a cross-tenant writer | Own tenant | Suspend, and the kill switch. Other writes on another tenant's agents are `platform_admin_read_only` |
| Tenant agent policy (`getTenantAgentPolicy`) | Needs `tenant_read`, which this route does not give a plain user | `tenant_read` | `tenant_read` | `cross_tenant` can read another tenant where the route says so |

A scope the token does not hold still refuses the call with `insufficient_scope`, whatever the role is.

## Workspaces

`workspace_list`, `workspace_current`, and `workspace_switch` are in the pinned workflow profile. `workspace_switch` is effect `write` with `always_confirm` false. That is the CR-1 reclassification. It is not a read. The pinned v3 operation that issues a token for another tenant the person already belongs to returns a new token pair, keeps the grant's client and audience, and does not widen scope. A caller with no membership gets `no_membership`. An OAuth client the target account has not authorized gets `consent_required`. API keys, portal links, agents, and token-exchange tokens are refused `person_session_required` on that route. The exception the spec states is a platform admin (`cross_tenant`) on an interactive session.

`workspace_switch` is not one of the five work-loop exemptions, so it carries `anthropic/requiresUserInteraction` even though `always_confirm` stays false. A client that honors that hint asks. Bare MCP and Cursor do not treat it as an approval dialog. See Write safety.

The CLI matches that. `enforcer workspace list`, `switch <name|code|tenant_id>`, and `current` move among workspaces the person already belongs to. `switch` needs `enforcer:workspace.write`, which the `work` preset requests when the server offers it. A workspace the person has not joined needs `enforcer login <CODE>` or an invite, not `switch`. After `consent_required`, one browser sign-in for that workspace is what later switches reuse.

**UNVERIFIED, pending Engineering (CR-4):** whether Cursor's MCP session follows a CLI `workspace switch` without a reconnect, and whether native Cursor OAuth can express the workspace at consent time. The protected-resource metadata that would tell a client the MCP resource identifier returned 404.

## Expiry, reconnect, and revocation

**UNVERIFIED.** Engineering's 2026-11-05 probe did not establish an access-token TTL or a refresh-token TTL. A `refresh_token` grant is advertised, and the CLI refreshes with it (`src/credentials.mjs`) when it has a refresh token, a token endpoint, and a client id. A comment in `bin/login.mjs` says the access token is about an hour. That comment is not the probe result. Do not publish a TTL.

**Revocation: UNVERIFIED, and there is no URL to publish.** Discovery does not advertise `revocation_endpoint`. `enforcer login logout` revokes the refresh token only when that field is present; otherwise it says the token stays valid until it expires. Removing a saved API key deletes it from this machine. The key still exists on the server until it is revoked there. This package does not document a product URL for that step.

**Reconnect.** Claude Code keeps the MCP process on the old token until `/mcp` reconnects. The login command says so. Cursor's reconnect, including after expiry, is **UNVERIFIED, pending Engineering (CR-4)**.

## Tool inventory

Source: the pinned manifest `enforcer/lib/api/spec/mcp-manifest.json`. The spec lock points `enforcer-v3-mcp` `tool-names.json` at `a164d134`, the CR-1 main tip Engineering named on 2026-11-06. The previous pin `09c07296` predates CR-1. This environment got HTTP 404 for the private repo, so a newer main tip was not compared and the 40-character SHA was not fetched. The vendored file is that previous pin with `workspace_switch` reclassified to effect `write` and `always_confirm` left false. Profiles and `always_confirm` below are that file. This is not a live `tools/list`.

Post-CR-1 the workflow profile in this pin is **50** tools: **27 read, 19 write, 4 destructive**. A connector assessment reported a tenant_admin `tools/list` of **46**. Whether production still shows 46 until a CR-4 redeploy is **UNVERIFIED, pending Engineering (CR-4)**. Do not pick 50 or 46 as the live count.

Other profiles in the same pin: `graph` 26, `governance` 12, `gvnr` 29, `full` 2, `readonly` 1 (`enforcer_setup_plan`), `support` 1 (`enforcer_setup_plan`). `gvnr` is a separate profile, not part of the workflow 50.

### Workflow profile (50)

27 read, 19 write, 4 destructive. `confirm` in this table means `always_confirm: true` in the pin. It is not the only server-side confirm signal. `anthropic/requiresUserInteraction` is separate and is described under Write safety. `workspace_switch` is on the write row.

| Effect | always_confirm | Tools |
|---|---|---|
| read | no | `agent_brief`, `agents_mine`, `enforcer_api_describe`, `enforcer_api_read`, `enforcer_api_search`, `enforcer_customer_context`, `enforcer_customer_find`, `enforcer_setup_plan`, `enforcer_tenant_health`, `enforcer_ticket_triage`, `enforcer_transfer_trace`, `enforcer_whoami`, `governance_activity`, `governance_decision_review`, `governance_overview`, `governance_session_investigate`, `governance_usage`, `graph_access`, `graph_epochs`, `graph_messages`, `graph_my_validations`, `graph_overview`, `graph_plan_status`, `graph_query`, `graph_recall`, `workspace_current`, `workspace_list` |
| write | no | `agent_create`, `agent_credential_issue`, `agent_groups`, `agent_set_enabled`, `agent_update`, `graph_decide`, `graph_heartbeat`, `graph_judge`, `graph_lifecycle`, `graph_next_work`, `graph_post`, `graph_remember`, `graph_report`, `graph_reset`, `graph_review`, `graph_set_tier`, `workspace_switch` |
| write | yes | `enforcer_setup_apply`, `graph_share` |
| destructive | no | `agent_credential_revoke`, `agent_credential_rotate` |
| destructive | yes | `enforcer_api_write`, `graph_unshare` |

The skills name these tools and were checked against this list. Names that are not MCP tools were corrected: the files skill had called `getActiveStorageProvider`, `listS3Files`, and `listGcsFiles` by a `files_` prefix those operationIds do not have. `graph_messages` and `graph_post` are in the pin; the graph skill's worker loop does not need them, and it does not claim to be the whole inventory. The governor skill is the CLI (`enforcer governor status|config|limit|verify|decide`), which `bin/enforcer` still exposes.

`enforcer_api_search` / `enforcer_api_describe` / `enforcer_api_read` / `enforcer_api_write` are the catalog. Per-operation tools are named by operationId in the pinned specs, not copied into this profile.

## API contracts

The contract you can read in this repo is the pin, counted from these files on 2026-11-06. The MCP pin bump does not change these four OpenAPI refs (`graph` `c0b13c86`, `v3` `ed13ea6d`, `files` `a3af8366`, `governance` `ba7871f1`):

| Spec | Path | operationIds | GET or HEAD |
|---|---|---|---|
| v3 (identity) | `enforcer/lib/api/spec/v3.json` | 342 | 141 |
| graph | `enforcer/lib/api/spec/graph.json` | 310 | 132 |
| files | `enforcer/lib/api/spec/files.json` | 68 | 26 |
| governance | `enforcer/lib/api/spec/governance.json` | 77 | 62 |
| **Total** | | **797** | **361** |

The other 436 operationIds use a method other than GET or HEAD. That is not a write count. Some of those methods are still reads.

**Pending Engineering (CR-3).** These hosted documents returned 404 on 2026-11-05. They are the intended source of truth and they are not working links today. Do not send a reader there expecting a spec:

- `https://api.instruxi.dev/api/v1/graph/swagger/doc.json`
- `https://api.instruxi.dev/api/v1/enforcer/swagger/doc.json`
- `https://api.instruxi.dev/api/v1/files/swagger/doc.json`
- `https://api.instruxi.dev/api/v1/governance/swagger/doc.json`
- `https://docs.instruxi.dev/openapi.json`

`docs.instruxi.dev`'s figure of 216 operations is a docs publish gap, not either of the counts below.

Two operation counts, both kept:

| Count | What it is | When | Source |
|---|---|---|---|
| **797** operationIds (361 GET or HEAD, 436 other methods) | This package's pinned OpenAPI specs | Counted 2026-11-06 from the files above | `enforcer/lib/api/spec/{v3,graph,files,governance}.json` |
| **about 1,135** operations (about 524 reads) | What `enforcer_api_search` reported on the live server | Connector assessment supplied with the listing request. Not re-measured here. Hosted swagger returned 404 on 2026-11-05 | That assessment. Pending Engineering (CR-3) before it can be checked again |

Neither number replaces the other. 797 is the pin. About 1,135 is the live figure that could not be reproduced while the hosted contracts 404.

## Write safety

This package does not promise that every write waits for a person.

Four layers get called "approval". They are not interchangeable. `always_confirm` is only the first.

**a. Server `always_confirm` (the pin flag).** The only tools with `always_confirm: true` are `enforcer_api_write`, `enforcer_setup_apply`, `graph_share`, and `graph_unshare`. The prompt text, and whether a client can allowlist that prompt for a project, are **UNVERIFIED**. They are not in this repo.

**b. Listing metadata `anthropic/requiresUserInteraction`.** Every write carries this hint except five work-loop exemptions: `graph_next_work`, `graph_heartbeat`, `graph_report`, `graph_remember`, and `update_task`. Engineering names `check-workloop-confirm.mjs` as the script that pins that set. The same five names are in agent-plugins #413's confirmation fixture. After CR-1, `workspace_switch` is a confirmed write through this hint even though `always_confirm` stays false. Clients that honor the hint, Claude Code among them, ask. Bare MCP and Cursor do not treat it as an approval dialog. `/enforcer:setup` can still write Claude Code `permissions.allow` rules so those prompted tools do not ask on every call. That allowlist is Claude Code. It is not this hint, and it is not Cursor.

**c. Governor hooks**, only while this plugin's hooks or `enforcer harness install cursor` are actually running. `lib/governor/core/capability.mjs` asks (and denies a headless worker) for `enforcer_api_write`, `agent_credential_issue`, `agent_credential_rotate`, `agent_credential_revoke`, and `graph_decide`. `enforcer_api_write` to a graph route is exempt when the session carries `GRAPH_ID`. No other MCP tool name is in those rules. On Cursor an ask becomes a deny: `hooks/cursor/shim.mjs` does not forward `ask`, because Cursor does not enforce `ask` on `preToolUse`. The shim denies the call and tells the person to approve it in the Enforcer console or change the policy, then retry. That is a block, not an approval dialog. `preToolUse` is `failClosed`. A bare MCP client never runs these hooks.

**d. Host portable confirmation (Engineering CR-5, agent-plugins #413, pending merge).** Separate from server `always_confirm`. Deny or cancel dispatches nothing. Approve runs the approved call once. A missing decision allows only pure reads plus the same five exemptions (`graph_next_work`, `graph_heartbeat`, `graph_report`, `graph_remember`, `update_task`). This package does not ship that contract. It is not merged. Do not treat it as behavior of the server today.

### Intentional exceptions

These are writes, credential operations, or destructive operations that the pin does **not** mark `always_confirm`. The Pin column is that flag only. A write that is not one of the five exemptions still carries RUI (layer b). Hooks do not cover all of them.

| Tool | Pin | What this repo can prove | What to do |
|---|---|---|---|
| `agent_credential_issue` | write, no confirm | Governor asks when hooks run; headless deny. The skill says the secret is shown once | Only when the person asked. Do not store the secret |
| `agent_credential_rotate`, `agent_credential_revoke` | destructive, no confirm | Same governor rule | Same. Rotate replaces a key; revoke stops one |
| `agent_create`, `agent_update`, `agent_set_enabled`, `agent_groups` | write, `always_confirm` false | No governor rule. Not in the five exemptions, so RUI applies | Claude Code asks via RUI. Cursor and bare MCP do not |
| `graph_decide` | write, no confirm | Governor asks; headless deny. Pinned spec: decides a gate (or a validation the skill uses it for) and moves the node | A person decides. Under Cursor the hook blocks until policy allows it |
| `graph_review` | write, `always_confirm` false | Pinned spec lists the queue with `GET /graphs/{graphId}/review` and resolves one item with `POST .../review/{itemId}/resolve`. The MCP tool's split between those is **UNVERIFIED**. Not in the five exemptions, so RUI applies | Treat a call as a possible write. Do not assume listing is side-effect free. Claude Code asks via RUI. Cursor and bare MCP do not |
| `graph_reset` | write, `always_confirm` false | Pinned `ResetRequest` is `expected_epoch`, `force`, and `reason`. No preview field. Omitting `expected_epoch` resets every call. `force: true` cancels running runs. RUI applies | Only when the person asked. Pass `expected_epoch`. Do not wait on `always_confirm`. Claude Code asks via RUI. Cursor and bare MCP do not |
| `graph_next_work`, `graph_heartbeat`, `graph_report`, `graph_remember` | write, no `always_confirm`, no RUI | Four of the five work-loop exemptions. Hooks follow `graph_next_work` for evidence. They do not ask before these calls | Expected unattended writes for a plan the person is running |
| `graph_post`, `graph_judge`, `graph_lifecycle`, `graph_set_tier` | write, no `always_confirm` | Not in the five exemptions, so RUI applies. Governor hooks do not match these names | Claude Code asks via RUI. Cursor and bare MCP do not |
| `workspace_switch` | write, `always_confirm` false | CR-1. Not a read. Not in the five exemptions, so RUI applies. The v3 route issues a new token pair | Claude Code asks via RUI. Cursor and bare MCP do not. See Workspaces |
| `enforcer_api_write` | destructive, confirm | Also a governor ask when hooks run, with the graph-route exemption | Show the target. Do not batch destructive calls |
| `enforcer_setup_apply`, `graph_share` | write, confirm | Server flag only | The setup command still asks the person before it calls apply |
| `graph_unshare` | destructive, confirm | Server flag only. Removing a share is a destructive scope the `work` preset does not request | Do not unshare because a prompt might appear |

Bare MCP use does not run governor hooks and does not treat RUI as an approval dialog. Server `always_confirm` is the only one of these layers that is a flag in the pin. Cursor does not turn an RUI hint or a governor ask into an approval button. The governor ask becomes a deny when the hooks ran. Host portable confirmation (layer d) is not merged.

## Listing

| Field | Value |
|---|---|
| Name | `enforcer` |
| Description | Connects Cursor to an Enforcer workspace through the hosted MCP server, with skills for identity, files, plans, and the governor. Its hooks record tool calls and block the writes the governor would ask a person to approve. |
| Keywords | `enforcer`, `mcp`, `identity`, `authorization`, `governance`, `workspace`, `audit` |
| Homepage | `https://instruxi.io` |
| Repository | `https://github.com/instruxi-io/agent-plugins` |
| License | `FSL-1.1-ALv2` (unchanged). See the repository `LICENSE`. Competing use is restricted until the future Apache-2.0 grant. Cursor's marketplace requires open source and a manual review. Whether FSL passes that review is a decision for the owner, not a license edit |
| Logo | No logo file is in this repo. The `logo` field is omitted on purpose |
| `displayName` | `Enforcer`, left as already set. Cursor's public manifest docs do not list this field. Whether a GUI load accepts it is **UNVERIFIED, pending Engineering (CR-4)** |
| Version | `1.9.7`, unchanged by this documentation change |

`docs.instruxi.dev` is not used as the homepage. Its operation count and its OpenAPI link are the publish gap in CR-3.

## Support and legal

TODO (Austin): support channel. This package does not add a support email, chat, status page, or community link.

TODO (Austin): terms of use. None are published from this repo. Do not treat the FSL license grant as a customer terms of service.

TODO (Austin): privacy notice. This package does not add a privacy commitment. The governor's existing note of what a signed-in install can send is `enforcer/lib/governor/README.md` under "What leaves your machine". That is behavior of the current code, not a privacy policy.

## UNVERIFIED index

| Item | Mark |
|---|---|
| Native Cursor OAuth, the callback allow-list, and which of the 69 scopes a Cursor grant gets | UNVERIFIED, pending Engineering (CR-4). Protected-resource metadata returned 404 |
| Which workflow tools a user, tenant_admin, or platform admin is offered. Pin says 50. A live tenant_admin list said 46 | UNVERIFIED, pending Engineering (CR-4) redeploy and `tools/list`. Do not pick one |
| Access-token and refresh-token TTL | UNVERIFIED. A refresh grant exists. No revoke URL is advertised |
| How to revoke a Cursor-issued token or an API key in the product | UNVERIFIED. No `revocation_endpoint` |
| Cursor MCP reconnect after sign-in, expiry, or workspace switch | UNVERIFIED, pending Engineering (CR-4) |
| Hosted Swagger/OpenAPI documents and `docs.instruxi.dev/openapi.json` | Pending Engineering (CR-3). They returned 404. Use the pin |
| `docs.instruxi.dev` "216 operations" | Docs publish gap |
| Live `enforcer_api_search` total of about 1,135 (about 524 reads) | Connector assessment supplied with the listing request. Not re-measured. Kept beside the pinned 797. Pending Engineering (CR-3) |
| `graph_review` MCP arguments (list versus resolve) | UNVERIFIED. The pin classifies the tool as a write. The OpenAPI spec has both a list and a resolve |
| Server confirmation copy, including project allowlisting of `always_confirm` | UNVERIFIED |
| Cursor GUI load of this plugin, and acceptance of the existing `displayName` field | UNVERIFIED, pending Engineering (CR-4). Public manifest docs do not list `displayName`. The field is unchanged |
| Support channel, terms, privacy notice | TODO (Austin). Owner decisions, not ship-readiness blockers |
| FSL and the marketplace open-source rule | Owner decision (Austin). License not changed. Not a ship-readiness blocker for this documentation change |
