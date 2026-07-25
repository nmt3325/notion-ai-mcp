# Notion AI 内部 API 仕様

調査日: 2026-07-23

> **非公式 API です。** Notion の公開 API ではなく、予告なく変更・停止されます。
> 個人検証用途に限定し、アカウント停止、データ損失、仕様変更のリスクを受け入れた上で使用してください。

## エンドポイント一覧

| 用途 | Method | Path | 認証 | リクエスト | レスポンス |
|---|---|---|---|---|---|
| アカウント/ワークスペース検出 | POST | `/api/v3/loadUserContent` | `token_v2` Cookie | `{}` | JSON `recordMap` (`notion_user`, `user_root`, `space`, `user_settings`) |
| Notion AI 送信 | POST | `/api/v3/runInferenceTranscript` | `token_v2` Cookie + user/space headers | workflow transcript | `application/x-ndjson`。環境差に備えて SSE `data:` 形式も許容 |
| 会話一覧 | POST | `/api/v3/getInferenceTranscriptsForUser` | 同上 | space pointer、種別、cursor | JSON `transcripts`, `recordMap.thread`, `nextCursor`, `hasMore` |
| メッセージ本体 | POST | `/api/v3/syncRecordValuesMain` | 同上 | `thread_message` pointer 配列 | JSON `recordMap.thread_message` |

ベース URL は `https://www.notion.so/api/v3` を既定値にしている。ブラウザの
`app.notion.com` サーフェスでは同一パスが `https://app.notion.com/api/v3` として観測された。

## 共通ヘッダ

| Header | 値/用途 |
|---|---|
| `Cookie` | `token_v2=<secret>`。必要に応じて `notion_browser_id`, `device_id`, `notion_user_id`, `notion_users` も送る |
| `content-type` | `application/json` |
| `accept` | JSON API は `application/json`、推論は `application/x-ndjson` |
| `notion-client-version` | Web クライアントバージョン。既定 `23.13.20260313.1423` |
| `x-notion-active-user-header` | Notion user UUID |
| `x-notion-space-id` | workspace/space UUID |
| `notion-audit-log-platform` | `web` |
| `origin` | `https://www.notion.so` |
| `referer` | 対象 space の Notion URL |
| `sec-ch-ua*`, `sec-fetch-*`, `user-agent` | ブラウザ互換ヘッダ。`notion_manager` の送信形式を踏襲 |

履歴 API は、同一オリジンの認証済み Web ページからは `accept` と
`content-type` だけでも成功した記録がある。MCP サーバーでは送信 API と同じ認証ヘッダを
付与し、単独プロセスからの呼び出しを安定させている。

## `runInferenceTranscript`

初回ターンの主要 body:

```json
{
  "traceId": "<uuid>",
  "spaceId": "<space-id>",
  "threadId": "<uuid>",
  "transcript": [
    { "id": "<uuid>", "type": "config", "value": { "type": "workflow", "useReadOnlyMode": true } },
    { "id": "<uuid>", "type": "context", "value": { "userId": "...", "spaceId": "...", "surface": "ai_module" } },
    { "id": "<uuid>", "type": "user", "value": [["prompt"]], "userId": "...", "createdAt": "<ISO-8601>" }
  ],
  "createThread": true,
  "generateTitle": true,
  "saveAllThreadOperations": true,
  "setUnreadState": false,
  "threadType": "workflow",
  "asPatchResponse": false,
  "isPartialTranscript": false,
  "threadParentPointer": { "table": "space", "id": "<space-id>", "spaceId": "<space-id>" },
  "debugOverrides": { "model": "<internal-model-id>", "emitAgentSearchExtractedResults": true }
}
```

継続ターンでは同じ `threadId`, config/context ID を再利用し、過去ターン数分の
`{"id":"<uuid>","type":"updated-config"}` を加える。`createThread=false`,
`generateTitle=false`, `isPartialTranscript=true` とする。

### ストリーム形式

Notion の実レスポンスは SSE ではなく、1行1 JSON の **NDJSON** が中心である。
`agent-inference.value[]` の `text.content` は差分ではなく累積文字列なので、最後に観測した
値を採用する。別形式の `patch` イベント (`o`, `p`, `v`) も処理する。hidden thinking、
tool use は回答本文へ混ぜない。`inputTokens` / `outputTokens` は完了イベントから集計する。

互換性のため、同じ JSON が `data: {...}` で包まれた SSE と `data: [DONE]` もパーサーが
受理する。

## `getInferenceTranscriptsForUser`

```json
{
  "threadParentPointer": {
    "table": "space",
    "id": "<space-id>",
    "spaceId": "<space-id>"
  },
  "includeWorkflowThreads": true,
  "includeWriterChats": false,
  "cursor": "<optional opaque cursor>"
}
```

レスポンスの `transcripts[]` はタイトル・時刻・種別を、
`recordMap.thread[threadId].value.value.messages` は順序付き message ID を返す。
`hasMore=true` の間は `nextCursor` で次ページを取得する。

MCP の `list_conversations` は、Notion 1ページの途中で `limit` に達しても項目を失わないよう、
Notion cursor とページ内 offset を `mcpv1.<base64url>` の不透明 cursor に包む。

## `syncRecordValuesMain`

```json
{
  "requests": [
    {
      "pointer": {
        "table": "thread_message",
        "id": "<thread-message-id>",
        "spaceId": "<space-id>"
      },
      "version": -1
    }
  ]
}
```

message ID を100件ずつ取得する。表示対象は次だけである。

- `step.type === "user"`: `step.value` の Notion rich text を Markdown に変換
- `step.type === "agent-inference"`: `step.value[]` の `type === "text"` だけを連結

`thinking`, `tool_use`, `agent-tool-result`, `config`, `context`, summary などの内部レコードは除外する。

## 根拠

- `notion_manager/internal/proxy/account_api.go`: `DiscoverAccountFromToken`
- `notion_manager/internal/proxy/notion.go`: `CallInference`, `buildConfigValue`,
  `buildContextValue`, `buildFullTranscript`, `buildPartialTranscript`, `setNotionHeaders`,
  `parseNDJSONStream`
- `notion_manager/internal/proxy/session.go`: thread/session と `updated-config` 管理
- `notion_manager/internal/proxy/transport.go`: Chrome uTLS/HTTP2 transport
- `Notion-chat-exporter/docs/internal-api-research.md`: 2026-07-19 の Playwright MCP 実通信記録
- `Notion-chat-exporter/contentScript.js`: `collectNotionChatFromInternalApi`,
  `syncInternalThreadMessages`, `getMessagesFromInternalThread`

詳細な検証結果は [research-and-validation.md](research-and-validation.md) を参照。
