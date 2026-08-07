# 調査・検証記録

## 調査結果

### 送信系 (`notion_manager`)

`SleepingBag945/notion_manager` のローカル checkout を読み、次の流れを採用した。

1. `DiscoverAccountFromToken` が `loadUserContent` で user/space/timezone を解決する。
2. `CallInference` が初回/継続ターンで transcript を切り替える。
3. `setNotionHeaders` が token cookie、active user、space、client version、ブラウザ互換ヘッダを設定する。
4. `parseNDJSONStream` が累積 `agent-inference` と `patch` の両方を処理する。
5. `Session` が thread ID、config/context ID、`updated-config` ID を保持する。

Go 実装は uTLS で Chrome の TLS fingerprint も再現する。本 TypeScript 実装は Node の標準
`fetch` を使うため TLS fingerprint の完全一致は行わないが、2026-07-23 の実 API 読み取りでは
通常の Node TLS で成功した。将来 Notion が TLS fingerprint を必須化した場合は、Go プロキシを
経由する transport オプションが必要になる。

### 履歴系 (Notion chat exporter)

ローカル exporter の Playwright MCP 調査記録では、認証済み `app.notion.com/chat` の
ネットワーク通信から次の二段階が確定していた。

1. `getInferenceTranscriptsForUser`: transcript metadata、thread record、順序付き message ID
2. `syncRecordValuesMain`: `thread_message` 本体

DOM スクロールは API が失敗した場合の fallback であり、MCP サーバーではブラウザ DOM がないため
採用していない。

## 2026-07-23 の実環境検証

秘匿情報と会話本文は出力せず、既存 `notion_manager` account JSON を外部設定として使用した。

| 対象 | 結果 |
|---|---|
| `getInferenceTranscriptsForUser` | 成功。3件を取得 |
| `syncRecordValuesMain` | 成功。先頭スレッドから user/assistant の2メッセージを復元 |
| MCP tool discovery | 成功。必須3ツールを列挙 |
| モック history/chat/stream E2E | 成功。9テスト通過 |
| `runInferenceTranscript` 実送信 | endpoint と NDJSON error event の受信まで成功。アカウント quota が枯渇しており `premium-feature-unavailable` で回答生成は不可 |

この表の実送信は account JSON の既定 workspace で実行した。その workspace は quota が枯渇して
いたため、続けて利用可能な別 workspace で再検証した。

### 指定 workspace での再検証

Codex 内 Playwright ブラウザのログイン済みセッションを使い、
`24.ぬまたかいち’s Space` へ切り替えて次を確認した。

| 対象 | 結果 |
|---|---|
| workspace 選択 | 対象 workspace のページ ID へ直接移動し、サイドバー表示名との一致を確認 |
| ブラウザ UI 送信 | 固定診断文を1件送信し、`NOTION_AI_MCP_OK` の生成完了を確認 |
| `list_conversations` | 成功。直前に作成した診断 thread を取得 |
| `get_conversation` | 成功。user/assistant の2メッセージを復元 |
| `notion_ai_chat` | 成功。応答16文字、応答 hash が `NOTION_AI_MCP_OK` の hash と一致 |
| Remote Streamable HTTP | Bearer認証付きで初期化、3ツール列挙、`list_conversations` の実API読み取りに成功 |
| ローカル回帰テスト | 10件すべて成功し、TypeScript build も成功 |

ブラウザ UI と MCP 実装の検証で診断 thread を各1件、合計2件作成した。本文・token・生の thread ID は
検証ログへ保存していない。ブラウザ操作だけではレスポンスストリームの生データを取得できないため、
送信 payload と NDJSON/SSE 解析は `notion_manager` の実装・保存済み Playwright キャプチャ・MCP からの
実送信結果を組み合わせて照合した。

Remote MCP追加後の回帰テストは10件となり、未認証リクエストの401拒否、HTTP session初期化、
ツール実行、session終了も自動テストしている。実環境のHTTP smoke testはlocalhostでのみ待ち受け、
固定の短命な診断用Bearer tokenを使用して終了後にプロセスを停止した。

実送信を再検証するには、利用可能な Notion AI quota を持つ `token_v2` で次を実行する。

```bash
NOTION_ACCOUNT_FILE=/absolute/path/account.json \
NOTION_SMOKE_CHAT=1 \
npm run smoke:live
```

スクリプトは token、会話タイトル、本文、応答本文を表示せず、件数・role・ID/応答の短い hash のみを
出力する。`NOTION_SMOKE_CHAT=1` はテスト用 thread を1件作成する。

## ローカル検証コマンド

```bash
npm run check
npm test
npm run build
```

テスト対象:

- Notion rich text → Markdown
- user-visible message の抽出と hidden step の除外
- 累積 `agent-inference` NDJSON
- `patch` NDJSON
- SSE `data:` compatibility
- transcript list → `thread_message` batch sync
- ページ途中 cursor
- 初回/継続 chat body
- MCP initialize / tools/list / tools/call

## バンドル解析の手順（ログイン不要）

1. ログインページを `wget` で取得し、`/_assets/*.js` を抽出する。
2. `app-*.js` に含まれる webpack の chunk マップ（`{id:"hash"}` の列、2099 件）を正規表現で抽出する。
3. `/_assets/<id>-<hash>.js` を並列ダウンロードする（`xargs -P 32`、24 秒で 960 ファイル / 47MB）。
4. `grep` で目的の識別子を探す。例: `oatmeal-cookie` → 9 chunk、うち model registry は 1 chunk。

この手順で model registry、workflow config キー、MCP 接続 UI のリクエスト形状を復元できます。

## クレジット枯渇の検出

無料プランの上限に達するとストリームに次のイベントが流れます。

```json
{ "type": "premium-feature-unavailable",
  "featureAvailability": { "limit": { "type": "cumulative", "total": 75, "current": 78 } } }
```

実測例: `animationsaver’s Space` で 78/75。これを検出して workspace ローテーションにつなげています。
なお、クレジット枯渇と MCP モジュールの可視性は無関係であることを、クレジットのある別 workspace で確認済みです。

## 環境失効からの復旧（2026-08-07）

ephemeral 環境の TTL 失効で v0.3.0〜0.7.4 の未プッシュコミット列を全損しました。
対策として、作業単位ごとに `git push` する運用に変更しています。

## 2026-08-07 Agent Service添付調査とv0.8.0

Notion Webのcurrent runtime mapを `wget` で取得し、2,070/2,071 chunksをローカル解析した。
owner module `265981` と実callerから次を復元した。

- `createAgentServiceFileUploadURL` / `completeAgentServiceFileUpload`
- `getFileContentURLForAgentThread`
- `createAgentThread` / `sendEventToAgentThread`
- file chat content: `[{type:"text",text}, {type:"file",file_id}]`
- 既存thread event: `{type:"user.message",content}`
- single-part / multipart transfer、multipart `ETag` completion
- `getThreadTranscript` の `put/patch/remove/rewind/session/session_status/committed` protocol

v0.8.0では `upload_attachment` と `download_attachment` を追加し、compiled stdio serverは18 toolsを列挙した。
ローカル回帰は60 testsで、single-part、multipart byte境界、ETag必須、checksum、path traversal、symlink、
byte上限、Agent Service 2-turn file chatに加え、workspace partial commit・delayed visibility・429/502・
no-retryを含めて全件成功した。追加hardeningでは、unknown/duplicate/out-of-range/missing multipart descriptorを
転送前に拒否し、signed request timeout、invalid create/complete response、upload/download size・SHA-256不整合、
19-file上限とdedupe、legacy inline contextとreal-file transport混在拒否を自動検証する。

認証復旧後、既存workspaceでAgent Service upload URL作成がHTTP 500、direct thread作成がHTTP 400に
なることを確認した。利用可能quotaを持つ新規workspaceでのupload → file chat → download checksum
lifecycleは、workspace作成rate limitの解除後に行うlive validation項目として残している。

## 2026-08-07 Workspace transaction・record-level検証

認証済みWeb UI、Rspack runtime、model factoryをローカル解析し、公式workspace作成手順を復元した。
base `/createSpace` の後に、space short IDを埋め込んだ`space_view` UUIDを生成し、`set`, `listAfter`,
`keyedObjectListAfter`の3 operationを`saveTransactionsFanout`へ送る。transaction bodyは新workspaceを
対象にする一方、HTTP routing headerは現在の有効workspaceに維持する。

初期実装がroot pointerの存在だけで成功判定した結果、`space_view` recordを欠くdangling entryが発生した。
read-only probeでrecord欠落を確認してから、対象IDがrootの両listにちょうど1件あることを検証し、
`listRemove`と`keyedObjectListRemove`を1 transactionで送ってdangling entryだけを削除した。
既存の正常なworkspaceとactive accountは変更していない。

修正版はroot 2 listの一意性、新しいspace record、`syncRecordValuesMain`で取得する完全な`space_view`
recordをすべて確認する。pointer-only、duplicate、missing recordは失敗し、切り替え・pin・永続化を行わない。
base作成後の失敗はpartial creationとして報告し、`/createSpace`もtransactionも再試行しない。

compiled stdio serverで1回だけlive作成を試したところ、`/createSpace`はHTTP 429を返した。実装は
response bodyを保持して終了し、再試行しなかった。前後のdiscoverable workspace数とactive workspaceは
不変で、account fileはmode `0600`、credentialも保持された。rate limit解除までは追加作成を行わない。

commit `2d3eace`に対するself-reporting CIはNode 24でTypeScript check、54/54 tests、build、
18-tool compiled stdio smoke、diff checkの全項目に成功した。
