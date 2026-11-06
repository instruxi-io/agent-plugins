---
name: enforcer
description: How Enforcer is organised — tenants, accounts, roles, scopes — and how to look up anything else from the live API instead of from memory. Use when the user mentions Enforcer, their workspace or tenant, members, invites, roles, API keys, or asks what they can do through the Enforcer MCP server.
---

# Enforcer

Enforcer is Instruxi's identity and authorization platform. This skill holds
only the ideas that rarely change. **Everything about specific endpoints comes
from the MCP server, never from memory**: the API changes, and a remembered
endpoint is how the old Enforcer skills went wrong.

## Look it up, don't recall it

The `enforcer` MCP server documents itself from the live spec:

1. `enforcer_api_search` — find an operation by domain noun ("invite",
   "api key", "role"), not by HTTP verb.
2. `enforcer_api_describe` — its parameters and shape.
3. `enforcer_api_read` for reads; `enforcer_api_write` for a catalog call
   that changes state. That tool is marked `always_confirm` in the pinned
   manifest. A client can still skip the prompt, and dedicated tools such as
   `graph_reset` are separate writes. See Safety below.

Prefer a dedicated workflow tool when one fits the question (tenant health,
customer lookup, transfer trace, ticket triage): one call instead of several.

## The model

- **Tenant** — a workspace. Every row belongs to exactly one; nothing crosses
  tenants unless a role says so. A tenant's `self_join_policy` decides whether
  people can join on their own or only by invite.
- **Account** — a person's membership in one tenant, with one role there.
  The same person can hold accounts in several tenants.
- **Role** — data, not a fixed list. Tenants can define their own, so read a
  role's permission grants (`tenant_read`, `tenant_write`, `tenant_manage`,
  `cross_tenant`), never infer power from its name.
- **Credential** — how a caller proves who it is: an OAuth sign-in
  (`/enforcer:login`) or an API key. Both act as the account they belong to.
  A sign-in is bound to one workspace: change it with `/enforcer:workspace
  switch <name>` when you are already a member, `/enforcer:login <CODE>` when not.
- **Scope** — what a credential may do, *narrower* than the role. An OAuth
  sign-in and a scoped API key carry only the scopes they were granted; an
  unscoped key carries its account's whole role.

## Building and managing your own agents

Tools: `agents_mine` (list agents you own or steward), `agent_brief` (one
agent: owner, steward, role, credentials, groups, audit events, governance
sessions), `agent_create`, `agent_update`, `agent_set_enabled`, `agent_groups`,
`agent_credential_issue`, `agent_credential_rotate`, `agent_credential_revoke`.
Do not issue, rotate, revoke, or disable a credential unless the person asked.
The governor hooks ask before the three `agent_credential_*` calls when they
are installed (a headless worker is denied). `agent_create`, `agent_update`,
`agent_set_enabled`, and `agent_groups` are not in those rules, and the pinned
MCP manifest does not mark them `always_confirm`. See
[docs/CURSOR.md](../../docs/CURSOR.md).

- Create an agent for one job with `agent_create`. Pick its role from the roles
  the tenant allows (`getTenantAgentPolicy`); do not invent one. Add it to
  groups with `agent_groups`.
- Issue a credential (`agent_credential_issue`) only when the person needs one.
  The secret is shown once: tell them to store it immediately. Never write it
  to a file or repeat it.
- Replace with `agent_credential_rotate`; stop use with `agent_credential_revoke`
  or `agent_set_enabled`.
- When an agent misbehaves, start with `agent_brief`: its audit events and
  governance sessions.

Never: set roles, use the kill switch or tenant policy, or touch an agent the
person does not own or steward.

## When something is refused

- `401` — no credential, or an expired one. Run `/enforcer:login status`.
- `403` / `insufficient_scope` — the credential is real but not allowed. Call
  `enforcer_whoami` to see the account, role, grants and scopes in play before
  guessing; the fix is usually a scope or role, not a retry.
- Nothing comes back from a list you expected to see — check which tenant the
  credential belongs to (`enforcer_whoami`). Tenancy filters silently.

## Safety

Nothing here promises that every write waits for approval. Confirmation
depends on the client and on whether the governor hooks are installed. The
boundary is [docs/CURSOR.md](../../docs/CURSOR.md).

- Catalog changes go through `enforcer_api_write`. The pinned MCP manifest
  marks that tool `always_confirm` and `destructive`. That flag is the
  server's. It is not a guarantee that every MCP client stops and asks, and a
  client that has allowlisted the tool will not ask again. Show what a
  destructive call will touch and wait for the person. Do not batch them.
- Dedicated workflow tools are separate calls. Beside `enforcer_api_write`,
  the pinned manifest marks only `enforcer_setup_apply`, `graph_share`, and
  `graph_unshare` as `always_confirm`. `graph_review` and `graph_reset` are
  writes with `always_confirm` false.
- With the governor hooks installed, `enforcer_api_write`,
  `agent_credential_issue`, `agent_credential_rotate`,
  `agent_credential_revoke`, and `graph_decide` are local ask rules (a
  headless worker is denied). Under Cursor the hook turns that ask into a
  deny, because Cursor does not enforce ask. A bare MCP session does not run
  these hooks.
- Never put an API key or token in a file, a command line, or a message. The
  authorization server probed on 2026-11-05 does not advertise a revocation
  endpoint, so do not promise that a leaked key can be revoked at a URL. Say
  that it should be revoked in the workspace, and that how is UNVERIFIED.

## Procedures

- Sign in: [login.md](login.md)
- Set a project up: [setup.md](setup.md)
- List or switch workspaces: [workspace.md](workspace.md)
