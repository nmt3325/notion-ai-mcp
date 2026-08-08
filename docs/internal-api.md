# Notion AI 内部 API 仕様

調査日: 2026-08-07

> **非公式 API です。** Notion の公開 API ではなく、予告なく変更・停止されます。
> 個人検証用途に限定し、アカウント停止、データ損失、仕様変更のリスクを受け入れた上で使用してください。

## エンドポイント一覧

| 用途 | Method | Path | 認証 | リクエスト | レスポンス |
|---|---|---|---|---|---|
| アカウント/ワークスペース検出 | POST | `/api/v3/loadUserContent` | `token_v2` Cookie | `{}` | JSON `recordMap` (`notion_user`, `user_root`, `space`, `user_settings`) |
| workspace base作成 | POST | `/api/v3/createSpace` | 同上 | name, plan, persona, device, source | JSON `spaceId` |
| workspace join transaction | POST | `/api/v3/saveTransactionsFanout` | 同上 | `space_view`作成 + user root 2 list更新 | JSON `{}` |
| Notion AI 送信 | POST | `/api/v3/runInferenceTranscript` | `token_v2` Cookie + user/space headers | workflow transcript | `application/x-ndjson`。環境差に備えて SSE `data:` 形式も許容 |
| 会話一覧 | POST | `/api/v3/getInferenceTranscriptsForUser` | 同上 | space pointer、種別、cursor | JSON `transcripts`, `recordMap.thread`, `nextCursor`, `hasMore` |
| メッセージ本体 | POST | `/api/v3/syncRecordValuesMain` | 同上 | `thread_message` pointer 配列 | JSON `recordMap.thread_message` |
| Agent Service thread作成 | POST | `/api/v3/createAgentThread` | 同上 | `type`, `threadId`, `content`, model等 | JSON `thread` |
| Agent Service継続送信 | POST | `/api/v3/sendEventToAgentThread` | 同上 | `event:{type:"user.message",content}` | JSON |
| Agent Service transcript | POST | `/api/v3/getThreadTranscript` | 同上 | `threadId`, direction, cursor, limit | patch page |
| upload URL作成 | POST | `/api/v3/createAgentServiceFileUploadURL` | 同上 | target, filename, mediaType, sizeBytes | file ID + transfer descriptor |
| upload完了 | POST | `/api/v3/completeAgentServiceFileUpload` | 同上 | target, fileId, multipart parts? | uploaded-file object |
| thread file URL | POST | `/api/v3/getFileContentURLForAgentThread` | 同上 | threadId, fileId, metadata flag | signed URL + metadata |
| assistant-transcript upload URL | POST | `/api/v3/getUploadFileUrlForAssistantChatTranscriptUpload` | 同上 | thread pointer, name, MIME, length, createThread | S3 POST descriptor + relative file URL + chatId |
| file URL署名 | POST | `/api/v3/getSignedFileUrls` | 同上 | original URL, download flag/name, permissionRecord | ordered signed URL array |
| assistant-transcript download proxy | GET | `https://app.notion.com/signed/<encoded-source-url>` | session Cookie | table, id, spaceId, name, download, userId, cache, imgBuildSrc | 200または302 |

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

## Workspace作成と検証

公式Web clientが送るbase request:

```json
{
  "name": "New workspace",
  "planType": "personal",
  "planSelection": "personal",
  "initialPersona": "other",
  "deviceId": "<device-id>",
  "deviceType": "web-desktop",
  "source": "sidebar_switcher"
}
```

`/createSpace` が返した `spaceId` のspace short IDを埋め込んだversion-8 UUIDを
`space_view` IDとして生成する。続く `/saveTransactionsFanout` は新しいworkspaceを
transaction bodyの`spaceId`と`cellTarget.spaceWithId`に指定し、次の3 operationを1 transactionで送る。

1. `space_view` recordを`set` (`parent_table:"user_root"`, `alive:true`, `joined:true`)
2. `user_root.space_views`へ`listAfter`
3. `user_root.space_view_pointers`へ`keyedObjectListAfter`

このfanout requestのHTTP `x-notion-space-id`は、まだ有効な**現在のworkspace**に維持する。
新しいworkspaceをrouting headerへ先に設定すると、cell provisioning前のrequestを誤ったcellへ送る可能性がある。

作成後はbounded pollingで次をすべて確認する。

- 生成IDが`user_root.space_views`にちょうど1回存在
- `{table:"space_view", id, spaceId}`が`space_view_pointers`にちょうど1回存在
- 新しい`space` recordが存在
- `syncRecordValuesMain`で取得した`space_view`の`id`, `space_id`, `parent_id`,
  `parent_table`, `alive`, `joined`が期待値と一致

pointerだけ見える状態は成功ではない。完全検証後にだけactive workspaceの切り替え、pin、
account JSONの更新を行う。account JSON更新ではcredentialと未知フィールドを保持し、mode `0600`にする。

重複作成を避けるため、`/createSpace`は1回だけ送る。base作成後のtransaction失敗や検証timeoutも
自動再試行しない。HTTP errorはstatus、最大2 KiBのbody、存在する場合は`Retry-After`を返す。

### `space_view` record検証request

```json
{
  "requests": [{
    "pointer": { "table": "space_view", "id": "<space-view-id>" },
    "version": -1
  }],
  "spacePointer": { "table": "space", "id": "<current-space-id>" }
}
```

## File chat と添付transport

Personal Agentの現行file chatは主にAgent Serviceを使う。一方、assistant chat surfaceには
`runInferenceTranscript`へattachment/computer-file stepをstageする別のupload経路があり、
Agent Service upload generationが利用できないworkspaceのfallbackとして使用できる。
Agent Service contentは最大20 block、textは先頭に最大1件、fileはupload済みIDで表す。

```json
[
  { "type": "text", "text": "このファイルを要約して" },
  { "type": "file", "file_id": "<file-id>" }
]
```

初回:

```json
{
  "type": "personal_agent",
  "spaceId": "<space-id>",
  "threadId": "<uuid>",
  "content": [{ "type": "text", "text": "..." }, { "type": "file", "file_id": "..." }],
  "model": "<internal-model-id>",
  "policies": { "approval_mode": "ask" },
  "browserEnabled": false,
  "clientMessageId": "<uuid>"
}
```

継続:

```json
{
  "spaceId": "<space-id>",
  "threadId": "<thread-id>",
  "event": { "type": "user.message", "content": [{ "type": "text", "text": "..." }] },
  "model": "<internal-model-id>",
  "policies": { "approval_mode": "ask" },
  "clientEventId": "<uuid>"
}
```

回答は `getThreadTranscript` をforward cursorで読み、次のpatch protocolを適用する。

- `put`: entity snapshotを保存
- `patch`: `append`, `add`, `replace` をentityへ適用。assistant textのstream pathは `/content/0/text`
- `remove`, `rewind`: entityを除去
- `session`, `session_status`, `committed`: session/commit stateを更新
- `kind:"turn_completed"`: turn完了
- `kind:"error"`: tool error

### Agent Service file upload

URL作成body:

```json
{
  "spaceId": "<space-id>",
  "target": { "type": "user" },
  "filename": "report.pdf",
  "mediaType": "application/pdf",
  "sizeBytes": 12345
}
```

既存thread向けは `target:{"type":"thread","threadId":"..."}`。新規thread作成前のuploadは
`target:{"type":"user"}` を使う。

single-part descriptor:

```json
{ "type": "single_part", "url": "<signed-url>", "method": "PUT", "headers": {} }
```

multipart descriptor:

```json
{
  "type": "multipart",
  "parts": [{ "part_number": 1, "url": "<signed-url>", "method": "PUT", "headers": {} }],
  "part_size_bytes": 20971520
}
```

multipartは期待part数、part numberの一意性と範囲、URL、methodを全件検証してから転送する。
各HTTP responseから `ETag` を取得し、完了bodyへ次の形で渡す。

```json
{
  "spaceId": "<space-id>",
  "target": { "type": "user" },
  "fileId": "<file-id>",
  "parts": [{ "partNumber": 1, "etag": "<etag>" }]
}
```

完了レスポンスのfile objectは `id`, `filename`, `media_type`, `size_bytes`, optional `sha256`。
file IDとsizeはrequest/local bytesに一致しなければならず、SHA-256があればlocal bytesと照合する。
thread fileのdownloadは `getFileContentURLForAgentThread({spaceId,threadId,fileId,includeFileMetadata:true})`
が返す `{url,file}` を使用する。signed URLはHTTPS（localhostだけHTTP可）、redirect禁止、request timeout付きで
取得し、metadataのsizeとSHA-256をdownload bytesに対して検証する。

legacy artifactは、元URLとpermission pointerが取得済みの場合に次のrequestで再署名する。

```json
{
  "urls": [{
    "url": "<original-file-url>",
    "download": true,
    "downloadName": "artifact.md",
    "permissionRecord": {
      "table": "thread",
      "id": "<thread-id>",
      "spaceId": "<space-id>"
    }
  }]
}
```

`getSignedFileUrls`のresponseは入力順の `signedUrls` array。legacy downloadはexactly one URLを要求し、
permissionRecordのspaceIdがactive workspaceと異なる場合は署名request前に拒否する。署名後のGETは
Agent Service downloadと同じtimeout・redirect・byte-limit・safe-output制約を使い、SHA-256を計算して返す。

### Assistant-transcript upload fallback

URL作成body:

```json
{
  "name": "<uuid>.<safe-extension>",
  "contentType": "text/csv",
  "assistantChatTranscriptSessionPointer": {
    "spaceId": "<space-id>",
    "table": "thread",
    "id": "<thread-id>"
  },
  "contentLength": 12345,
  "createThread": true
}
```

responseは`url`, `signedGetUrl`, `signedUploadPostUrl`, `postHeaders`, `fields`, `chatId`を返す。
`postHeaders`は`[{name,value}]` array。S3 POSTはresponse順に`fields`を`FormData`へ追加し、
最後に`file`を追加する。成功statusは200または204だけを許可する。

processingを使えない場合の公式fallback step:

```json
{
  "id": "<uuid>",
  "type": "computer-file",
  "fileUrl": "<relative-upload-url>",
  "fileName": "report.csv",
  "contentType": "text/csv",
  "metadata": {
    "fileSize": 12345,
    "attachmentSource": "user_upload"
  }
}
```

MCP実装は署名URL、S3 policy、security token、form fieldを永続化・出力しない。代わりにworkspace、
thread、relative file URL、plain filename、MIME、size、SHA-256をin-memory opaque handleへ紐づける。
handleのdownloadはcurrent Web clientの`/signed/<encodeURIComponent(fileUrl)>` proxyへ
`table:"thread"`, `id:threadId`, `spaceId`, `name`, `download:true`, `userId`, `cache:v2`,
`imgBuildSrc:getSignedFileProxyUrl`を送る。proxy requestだけにsession Cookieを付け、302の`file.notion.com`
redirectには`full_cookie`から抽出した`file_token`だけを付ける。他hostへNotion Cookieを転送しない。
proxyとredirect URLの双方でHTTPS、userinfo、private/link-local/metadata hostを検証し、size/SHA-256を再検証する。
workspace/thread/transport混在と再利用済みstepを拒否し、workspace switchまたはprocess restartでhandleを破棄する。

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

## MCP 接続関連エンドポイント

いずれも `POST /api/v3/<name>` で、Cookie に `token_v2`、ヘッダーに `x-notion-space-id` と
`x-notion-active-user-header` を付与します。

| endpoint | body | 用途 |
|---|---|---|
| `checkMcpOAuthSupport` | `{ serverUrl }` | OAuth 対応の確認 |
| `validateMcpConnection` | `{ serverUrl, spaceId, authHeaders, approvalIntent }` | 接続検証と tool 一覧取得 |
| `saveTransactionsFanout` | `{ requestId, transactions: [...] }` | `workflow_module` の作成/更新/削除 |
| `postWorkflowsMcpServerConnect` | `{ integrationId, spaceId, authHeaders, initiationContext, approvalIntent }` | 接続確定 |
| `initiateMcpOAuth` | `{ serverUrl, spaceId, integrationId, name? }` | `authorizationUrl` を返す |
| `getPreconfiguredMcpServers` | `{}` | Notion 標準の MCP カタログ（21 件） |

`workflow_module` レコードの主要キー: `alive, created_by_id, created_by_table, created_time, data, id,
last_edited_by_id, last_edited_by_table, last_edited_time, module_type, parent_id, parent_table, space_id, version`。
`data` の中身: `connectionPointer, enabledResourceUris, enabledToolNames, icon, id, name, officialName,
preferredTransport, runReadToolsAutomatically, runWriteToolsAutomatically, serverInstructions, serverUrl, tools`。
`enabledToolNames`省略は全tool、外部APIの空配列は全tool無効。永続化時は現行UIと同じ`["__NONE__"]` sentinelへ変換し、list/statusでは空配列へ戻す。read自動実行は省略/trueが有効、write自動実行はtrueだけが有効となる。

削除は `saveTransactionsFanout` で `args: { alive: false }`、更新は `path: ["data"]` と `path: []` の
2 オペレーションを送ります。

### Personal Agent MCP 永続化とstatus

Personal/global MCP接続は2 recordを協調更新する。

1. `workflow_module`はcurrent model factoryと同じ必須fieldで作成する。`created_time`と`last_edited_time`は1つのtimestampを共有し、creator/editor tableとparent tableはいずれも`notion_user`、parent IDはcurrent userとする。
2. current `space_view`を`syncRecordValuesMain`で読み、settings全体と既存`agent_chat_modules`を保持したまま、`{pointer:{table:"workflow_module",id,spaceId},defaultEnabled:false}`を重複なく追加する。

一覧取得もこのspace-view listをsource of truthにし、linked pointerをdeduplicateして1回の`syncRecordValues`でbatch readする。liveかつdeadなlinked moduleを安全なsummaryへ変換し、current workspace/viewのlocal registry metadataだけをmergeする。registry-only stale recordは`linked:false`、Notion-only recordのauth typeは`unknown`とし、raw `connectionPointer`やexternal-connection recordは返さない。

updateもregistryをsource of truthにしない。current `space_view`へのlink、pointerのspace、live `workflow_module`のtype/space/idを検証してから、既存`data`全体をshallow mergeする。name-only、`enabledToolNames`、read/write run policy更新はvalidation/connectを行わない。tool名はcached catalogに照合し、空配列は`["__NONE__"]`として全無効、nullはfull `data` setでfieldを削除（全有効）する。server URLまたはtransport変更は明示的authを必須とし、先に`validateMcpConnection`を実行する。明示tool filterは再validation後のcatalogに照合し、validated toolsがnon-emptyの場合だけtoolsを置換する。commit後に`postWorkflowsMcpServerConnect`へ`initiationContext:"reconnect"`を送り、authだけを明示した再認証も同じ経路を使う。

connectはこの2 commitの間で実行する。connect、visibility commit、local registry保存のいずれかが失敗した場合は、作成済みmoduleをdead化し、そのmodule IDに一致するpointerだけを削除する。removeもdead + unlinkを1 transactionで行い、他のsettings/module pointerは変更しない。update/remove/statusはcurrent Notion linkageとrecordを検証し、registry recordがある場合はactive workspace/viewとの不一致を拒否する。

Personal Agent moduleには`workflowId`がないため、`getMcpOAuthStatus`は使用できない。statusは`syncRecordValues`で`workflow_module`と参照先`external_connection`を読み、space-view linkageと合わせて判定する。pointerなしは`needs_setup`、external connectionの`authenticated:false`は`needs_reauth`、liveかつlinkedでそれ以外は`connected`、deadまたはunlinkedは`disconnected`となる。2026-08-07のcompiled-stdio live lifecycleではNotion-only update/reconnectとcleanupを含めて検証し、67/67 testsが成功した。

## モデルレジストリ

Web バンドルの chunk に、全モデルの定義がインラインで含まれます（ログイン不要）。

```
{ notionName: "oatmeal-cookie", modelFamily: "openai", maxOutputTokens: 128000,
  maxContextTokens: 400000, isProductionCallable: true, isProductionPickable: true,
  isThinkingEnabled: true, pricing: {...},
  displayName: "GPT 5.2", displayNameWithProvider: "GPT 5.2", displayGroup: "fast" }
```

179 エントリ中 74 が `isProductionCallable`。`src/models.ts` はこれを取り込んだカタログです。

## Attachment lifecycle invariants

- `conversationId`を指定した`auto` uploadは、Agent Service upload生成が失敗しても新しいassistant-transcript threadへretargetしない。
- activeなinference-transcript conversationには後続fileをuploadできる。official Web helperと同じくupload URL requestの`createThread`は`true`のまま、次のinference requestは`createThread:false` / `isPartialTranscript:true`になる。
- opaque transcript handleはthread・workspace・server processに固定され、1回だけchatへ添付できる。cross-thread、Agent Service IDとの混在、restart後、workspace切替後は拒否する。
- temporary storage completionはHTTP 200または204だけを受理し、201を含む他の2xxを成功扱いしない。
