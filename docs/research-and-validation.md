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
