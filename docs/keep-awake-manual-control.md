# Keep me awake: manual control surface

`keep_me_awake` is normally started by the model through MCP. The HTTP server also exposes the same
supervisor over plain REST so a browser extension (or `curl`) can start, inspect and stop watchdogs
by hand.

Everything lives under `/keep-awake` on the remote HTTP server, uses the **same bearer token as
`/mcp`** (`NOTION_MCP_HTTP_BEARER_TOKEN`) and shares one `KeepAwakeSupervisor` instance with the MCP
tool, so a watchdog started from the UI is the same object the model sees.

## Routes

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/keep-awake` | List tracked watchdogs (`?limit=1..100`, default 20) | `200 { serverNow, defaults, keepAlives }` |
| `POST` | `/keep-awake` | Start watching a conversation | `201 { serverNow, defaults, keepAlive }` |
| `POST` | `/keep-awake/stop-all` | Stop every active watchdog | `200 { serverNow, stopped }` |
| `GET` | `/keep-awake/:id` | Read one watchdog | `200 { serverNow, keepAlive }` |
| `POST` | `/keep-awake/:id/check` | Evaluate now (nudge decision without waiting for the poll) | `200 { serverNow, decision: { action, reason }, keepAlive }` |
| `POST` | `/keep-awake/:id/kick` | Force a nudge | `200 { serverNow, keepAlive }` |
| `POST` | `/keep-awake/:id/stop` | Stop one watchdog | `200 { serverNow, keepAlive }` |

`serverNow` is epoch milliseconds and lets a client correct for clock skew when it renders
`deadlineAt` / `lastNudgeAt`. `defaults` mirrors the server's configured defaults so a UI can
pre-fill its form without hardcoding them.

### Start payload

```json
{
  "conversationId": "3ddd5368-c6db-8041-8492-00a95d75faa7",
  "idleSeconds": 120,
  "pollSeconds": 30,
  "cooldownSeconds": 60,
  "maxNudges": 40,
  "deadlineMinutes": 180,
  "autoContinue": true,
  "maxContinues": 10,
  "language": "ja",
  "message": "続けて",
  "doneToken": "DONE"
}
```

Only `conversationId` is required. Bounds: `idleSeconds` 60–900, `pollSeconds` 5–300,
`cooldownSeconds` 0–1800, `maxNudges` 1–500, `deadlineMinutes` 1–1440, `maxContinues` 0–100,
`language` `ja`|`en`, `doneToken` 3–64 chars, `message` 1–2000 chars.

### Errors

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ error, code: "invalid_request", issues }` | Validation failed; `issues` lists each field |
| `401` | `{ error }` + `www-authenticate: Bearer` | Missing/incorrect bearer token |
| `404` | `{ error, code: "not_found" }` | Unknown watchdog id or path |
| `405` | `{ error }` + `allow` | Wrong method for the path |
| `409` | `{ error, code: "keep_awake_disabled" }` | `NOTION_KEEP_AWAKE` is not enabled |
| `413` | `{ error }` | Request body over 1 MiB |
| `502` | `{ error, code: "notion_unavailable" }` | Notion rejected the underlying call |

## CORS

Browser clients are allowed by origin. `NOTION_MCP_HTTP_ALLOWED_ORIGINS` takes a comma-separated
list and defaults to the Notion web origins, so the extension's `fetch` from a Notion tab works
without extra configuration. Preflights answer with the same header allowlist the MCP endpoint uses
(`authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id`).

Keep the server bound to `127.0.0.1` (the default) unless you intentionally expose it: the bearer
token is the only thing protecting these routes.

## Trying it without Notion

`scripts/keep-awake-ui-fixture.ts` boots the same HTTP surface with a stub Notion client and two
seeded watchdogs, which is what the extension's browser verification runs against:

```bash
npx tsx scripts/keep-awake-ui-fixture.ts
# keep-awake fixture listening on http://127.0.0.1:3000

curl -s -H 'authorization: Bearer ui-fixture-not-a-secret-bearer-token-00000000' \
  'http://127.0.0.1:3000/keep-awake?limit=5' | jq '.keepAlives[].status'
```

Override `KEEP_AWAKE_FIXTURE_SEEDS` (comma-separated conversation ids) to change what it seeds, and
`NOTION_MCP_HTTP_BEARER_TOKEN` / `NOTION_MCP_HTTP_PORT` to change the token and port. The fixture is
for local UI work only — it never talks to Notion.

## Tests

`tests/keep-awake-http.test.ts` covers route resolution, auth, validation bounds, the disabled
(`409`) path and each action against an in-memory supervisor. Run the whole suite with `npm test`.
