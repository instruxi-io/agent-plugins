---
name: files
description: Work with files in the user's Enforcer workspace — find, inspect, share with a group, upload and download. Use when the user mentions files, documents, uploads, attachments or storage in Enforcer, or asks to put a local file into their workspace or get one out of it.
---

# Enforcer files

Files live in the workspace's storage provider (S3, GCS or Storj; the tenant
chooses). One grant means the same on every provider.

## Finding and inspecting: the MCP server

Use the `enforcer` MCP server's catalog. Search by the domain noun, then read
or write the operation id the search returns:

- `enforcer_api_search` for "storage provider", "s3 files", "gcs files", or "share"
- `enforcer_api_read` for lists, metadata, and presigned download URLs
- `enforcer_api_write` for move, copy, and sharing

The pinned files spec (`lib/api/spec/files.json`) tags these operations
`files` and names them by operationId: `getActiveStorageProvider`,
`listS3Files`, `listGcsFiles`, and `listStorjFiles`. There is no `files_`
prefix on those ids. Ask `getActiveStorageProvider` first when the provider
matters: it decides which list operation applies. The OAuth scope families
are `enforcer:files-files` and `enforcer:files-sharing`. Those names are
scopes, not the OpenAPI tag and not the operationId.

`enforcer_api_write` is marked `always_confirm` in the pinned MCP manifest.
That is the server's flag, not a promise that every client asks. Do not batch
destructive calls. The write-safety boundary is
[docs/CURSOR.md](../../docs/CURSOR.md).

## Moving bytes: the commands, never the tools

A tool call cannot carry a file, and a file's contents should not pass through
the model. Use:

- `/enforcer:upload <path> [--dir <directory>] [--overwrite]`
- `/enforcer:download <file_id|path> [--out <path>]` (the path as you uploaded it, e.g. `docs/report.pdf`)

They pick the provider's flow themselves (presigned URL for S3, multipart for
GCS and Storj) and use the `/enforcer:login` sign-in.

## What a sign-in may do

File scopes look like `enforcer:files-<tag>.<effect>`. The default browser
preset `work` (`enforcer login`, no `--for`) requests
`enforcer:files-files.write`. It does not request
`enforcer:files-sharing.write`. Sharing needs that scope; ask for it with
`--scope` or a preset that includes it. The `work`, `plan`, and `agents`
presets in `bin/login.mjs` do not request `.destructive` scopes. `--for admin`
asks for every scope the server offers, including destructive ones when they
are offered, and the CLI refuses that sign-in when the token is too large
(HTTP 431).

Which of those scopes a Cursor OAuth grant actually receives is UNVERIFIED,
pending Engineering (CR-4). The authorization server advertised 69 scopes on
2026-11-05; tool access is still filtered by server profile.

A refusal with `insufficient_scope` means the credential is narrower than the
call. Say which scope the message names; do not retry it. Buckets,
connections, and the OCR queue are not in the `work` preset; look them up
with `enforcer_api_search` rather than guessing an admin-only tag.
