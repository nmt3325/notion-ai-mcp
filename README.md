# Notion AI MCP Server

Notion AI の非公式な内部 API を MCP サーバーとしてラップする、個人検証用の TypeScript 実装です。
stdioと認証付きStreamable HTTPの両方で、Claude Code、Cursor、Notion AI 本体などから次の 23 ツールを利用できます。

**チャット / 履歴**

- `notion_ai_chat`: Notion AI にプロンプトを送信し、NDJSON/SSE ストリームを集約して返す（モデル・reasoningEffort 指定、添付対応）。MCP client が約60秒で呼び出しを放棄するため、既定45秒で切り上げて `jobId` 付きの `pending` を返し、生成はサーバー側で継続する
- `get_chat_result`: 待機打ち切り後・タイムアウト後の回答を job または thread 本文から回収する
- `list_chat_jobs`: バックグラウンドで走らせた chat job の状態・conversationId を一覧する
- `keep_me_awake`: 長いタスクの途中で止まったターンを検知して継続を促す短いメッセージを自動送信する
- `interrupt_conversation`: thread が握ったままの inference lease を解除して、稼動中扱いで拒否される送信を通す
- `list_conversations`: Notion AI の workflow/chat thread をページング取得する
- `get_conversation`: 指定 thread の user-visible な user/assistant メッセージを取得する
- `rename_conversation`: active workspace内のthreadを検証してタイトル変更する
- `delete_conversation`: active workspace内のthreadを検証して削除する（`confirm: true`必須）
- `upload_attachment` / `download_attachment`: Agent Serviceまたはassistant-transcript transportでファイルを安全にupload/downloadする

**ワークスペース**

- `list_workspaces` / `get_current_workspace`: アカウント内の workspace 一覧と現在の workspace
- `switch_workspace`: space ID または名前（部分一致可）で切り替え、`pin` で固定
- `create_workspace`: 公式 Web transaction 形状で新規 workspace を作成し、完全検証後に切り替え・固定

**MCP 接続管理（Notion 側の Settings > Connections > MCP を API から操作）**

- `list_mcp_connections` / `add_mcp_connection` / `update_mcp_connection` / `remove_mcp_connection`
- `get_mcp_connection_status` / `check_mcp_oauth_support` / `start_mcp_oauth` / `complete_mcp_oauth`
- `list_preconfigured_mcp_servers` / `connect_preconfigured_mcp_server`

## 重要な注意

このプロジェクトは Notion の公開 API ではなく、Web アプリ用の内部 API と `token_v2` Cookie を
使用します。Notion の利用規約に抵触する可能性、アカウント停止、quota 消費、予告なしの仕様変更、
データ破損のリスクがあります。**個人利用・検証目的に限定し、自己責任で使用してください。**

`token_v2` は Notion アカウントと同等に機密です。`.env`、account JSON、HAR、capture log を
Git に追加しないでください。本リポジトリの `.gitignore` は代表的な秘匿ファイルを除外しますが、
最終的な管理責任は利用者にあります。

## 必要環境

- Node.js 20 以上
- Notion にログイン済みのブラウザから取得した `token_v2`
- Notion AI を利用できる workspace/quota

## セットアップ

```bash
npm install
npm run build
```

最小設定:

```bash
export NOTION_TOKEN_V2='...'
node dist/src/index.js
```

`NOTION_SPACE_ID` と `NOTION_USER_ID` を省略すると、起動後の最初の tool call で
`loadUserContent` を使って account/workspace を解決します。自動検出は space レコードを
参照できない pointer（退会済み・削除済み workspace など）を候補から除外し、
`NOTION_PINNED_SPACE_ID`、次に AI 有効・有料 plan の順で選びます。
`NOTION_SPACE_ID` だけを指定した場合、自動検出はその workspace を上書きせず、
不足している `space_view_id` や表示名だけを補完します。

`notion_manager` 互換の account JSON がある場合:

```bash
export NOTION_ACCOUNT_FILE=/absolute/path/to/account.json
node dist/src/index.js
```

環境変数は account JSON より優先されます。完全な一覧は [.env.example](.env.example) を参照。
`switch_workspace` / `create_workspace` に `pin:true` を指定すると、`space_id`, `space_view_id`,
`space_name`, `pinned_space_id` を account JSON へ mode `0600` で保存します。既存の `token_v2`,
`full_cookie` と未知のフィールドは保持します。

1アカウントに複数 workspace があり、永続設定とは別の workspace を一時的に使う場合は
`NOTION_SPACE_ID` と `NOTION_SPACE_VIEW_ID` を明示してください。起動時から固定する場合は
`NOTION_PINNED_SPACE_ID` も指定できます。

| 変数 | 必須 | 説明 |
|---|---:|---|
| `NOTION_TOKEN_V2` | 条件付き | `NOTION_ACCOUNT_FILE` に `token_v2` がなければ必須 |
| `NOTION_ACCOUNT_FILE` | 条件付き | `notion_manager` 互換 JSON。token をリポジトリ外に置くことを推奨。未作成のパスを指定してもよく、`switch_workspace`(pin) 実行時に 0600 で作成される |
| `NOTION_SPACE_ID` | 任意 | workspace UUID。指定時は自動検出より優先。未指定時は自動検出 |
| `NOTION_SPACE_VIEW_ID` | 任意 | workspace の `space_view` UUID |
| `NOTION_PINNED_SPACE_ID` | 任意 | 起動時に復元する固定 workspace UUID |
| `NOTION_USER_ID` | 任意 | user UUID。未指定時は自動検出 |
| `NOTION_CLIENT_VERSION` | 任意 | 既定 `23.13.20260313.1423` |
| `NOTION_DEFAULT_MODEL` | 任意 | Notion 内部 model ID。既定 `almond-croissant-low` |
| `NOTION_API_BASE` | 任意 | 既定 `https://www.notion.so/api/v3` |
| `NOTION_REQUEST_TIMEOUT_MS` | 任意 | 内部 API request timeout（workspace操作にも適用）。既定 300000 ms |
| `NOTION_MAX_WORKSPACE_RETRIES` | 任意 | credit枯渇時のworkspaceローテーション上限。既定5、`0`で無効 |
| `NOTION_CHAT_WAIT_MS` | 任意 | `notion_ai_chat` が inline で待つ上限。既定 45000 ms（1000〜55000）。MCP client の約60秒制限より短く保つ |
| `NOTION_STATE_FILE` | 任意 | chat job と継続session の保存先（mode 0600）。既定 `~/.notion-ai-mcp/state.json`、`off` で保存無効 |
| `NOTION_SESSION_REHYDRATE` | 任意 | 未知の `conversationId` を thread から復元して継続する。既定有効、`0` で無効 |
| `NOTION_DEFAULT_WEB_SEARCH` | 任意 | 新規 chat の web 検索。既定 有効（`0` で無効） |
| `NOTION_DEFAULT_WORKSPACE_SEARCH` | 任意 | 新規 chat の workspace 検索。既定 有効（`0` で無効） |
| `NOTION_DEFAULT_READ_ONLY` | 任意 | Ask（読み取り専用）モード。既定 無効 = Agent モードで spawn（`1` で Ask 固定） |
| `NOTION_FULL_COOKIE` | 任意 | 完全なCookie header。assistant-transcript downloadにはブラウザsessionの`file_token`が必要 |
| `NOTION_MODEL_ALIASES` | 任意 | モデル別名を追加/上書きする JSON。例 `{"my-fast":"oatmeal-cookie"}` |
| `NOTION_MCP_REGISTRY_FILE` | 任意 | 登録済み MCP 接続の保存先（mode 0600） |
| `NOTION_ATTACHMENT_ROOT` | 任意 | upload元/download先として許可するroot。既定は起動時のworking directory |
| `NOTION_MAX_ATTACHMENT_BYTES` | 任意 | upload/download 1ファイルの上限。既定 `20971520` (20 MiB) |

## Remote Streamable HTTP

stdio版とは別に、MCP Streamable HTTPエンドポイントを起動できます。HTTP版はBearer認証が必須です。
Bearer tokenには `token_v2` を流用せず、別の十分長いランダム値を使ってください。

```bash
npm run build
export NOTION_ACCOUNT_FILE=/absolute/path/account.json
export NOTION_MCP_HTTP_BEARER_TOKEN="$(openssl rand -hex 32)"
npm run start:http
```

既定の待受先は `http://127.0.0.1:3000/mcp`、ヘルスチェックは
`http://127.0.0.1:3000/healthz` です。MCPクライアントは全リクエストに次を付けます。

```http
Authorization: Bearer <NOTION_MCP_HTTP_BEARER_TOKEN>
```

HTTP版の設定:

| 変数 | 既定値 | 説明 |
|---|---|---|
| `NOTION_MCP_HTTP_BEARER_TOKEN` | なし | 必須。32文字以上のRemote MCP専用token |
| `NOTION_MCP_HTTP_HOST` | `127.0.0.1` | 待受アドレス。通常はTLS reverse proxyと同じホスト内だけで待ち受ける |
| `NOTION_MCP_HTTP_PORT` | `3000` | 待受ポート |
| `NOTION_MCP_HTTP_PATH` | `/mcp` | Streamable HTTP endpoint |
| `NOTION_MCP_HTTP_SESSION_TTL_MS` | `3600000` | 非アクティブsessionの保持時間 |
| `NOTION_MCP_HTTP_MAX_SESSIONS` | `100` | 同時sessionの上限 |

クライアント設定の概念例:

```json
{
  "mcpServers": {
    "notion-ai": {
      "type": "http",
      "url": "https://notion-ai-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <remote-mcp-token>"
      }
    }
  }
}
```

設定ファイルへtokenを直接保存できないクライアントでは、クライアント側の環境変数・Secret機能を
利用してください。HTTPのままインターネットへ公開せず、Caddy、Nginx、Cloudflare Tunnelなどで
HTTPS終端してください。サーバーを再起動するとHTTP sessionと、そのsession内の継続chat状態は失われます。

Cloudflare Quick Tunnelで短時間の疎通試験をする場合は、HTTP serverを`127.0.0.1`で起動したまま別terminalで実行します。
Quick TunnelはURL・uptimeの保証がなくproduction向けではありません。公開URL自体に認証機能はないため、十分長い
Remote MCP専用Bearer tokenを必ず維持してください。

```bash
cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:3000

export NOTION_MCP_REMOTE_URL=https://<generated-host>.trycloudflare.com
export NOTION_MCP_REMOTE_CALL_READ=1
npm run smoke:http:remote
```

remote smokeは、未認証requestが401になること、TLS越しのMCP initialize、20-tool listing、任意の
`get_current_workspace` read callを検証します。Bearer tokenやworkspace responseは出力しません。

最小のCaddy例:

```caddyfile
notion-ai-mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

## Docker

### イメージの取得

`main` への push と `v*` タグで GHCR に自動ビルド・自動 push されます
(`.github/workflows/docker-image.yml`、linux/amd64 + linux/arm64)。

```bash
docker pull ghcr.io/nmt3325/notion-ai-mcp:latest
```

タグは `latest` / `main` / `sha-<commit>` / `v1.2.3` / `1.2` が付きます。
リポジトリが private の間は package も private なので、pull 前に
`echo $GHCR_PAT | docker login ghcr.io -u nmt3325 --password-stdin` が必要です。

### docker compose で HTTP モードを起動

```bash
cp .env.example .env      # NOTION_TOKEN_V2 と NOTION_MCP_HTTP_BEARER_TOKEN(32文字以上) を設定
docker compose up -d
curl -fsS http://127.0.0.1:3000/healthz   # {"status":"ok"}
docker compose logs -f mcp-http
```

- コンテナ内では `NOTION_MCP_HTTP_HOST=0.0.0.0` 固定、公開側は既定で `127.0.0.1:3000` のみ。
  LAN に出すなら `NOTION_MCP_HTTP_BIND_ADDRESS=0.0.0.0`、インターネット公開は TLS リバースプロキシ経由で。
- 添付ファイルの入出力は named volume `notion-ai-mcp-data` を `/data` にマウントし
  `NOTION_ATTACHMENT_ROOT=/data` / `NOTION_MCP_REGISTRY_FILE=/data/mcp-connections.json` としています。
  ホストのファイルを渡したい場合は `- ./work:/data` などに差し替えてください。
- コンテナは `read_only` + `no-new-privileges` + 非 root (`node`) 実行。書き込みは `/data` と `/tmp` のみ。

### stdio モード

```bash
docker compose run --rm -T mcp-stdio
# または compose なしで
docker run -i --rm --env-file .env -v notion-ai-mcp-data:/data \
  ghcr.io/nmt3325/notion-ai-mcp:latest node dist/src/index.js
```

Claude Code / Cursor に登録する場合は `command` を `docker`、`args` を
`["run","-i","--rm","--env-file","/abs/path/.env","ghcr.io/nmt3325/notion-ai-mcp:latest","node","dist/src/index.js"]`
にします。

### ローカルビルド

```bash
docker compose build            # compose 経由
docker build -t notion-ai-mcp:dev .
docker build --build-arg NODE_VERSION=24 -t notion-ai-mcp:node24 .
```

multi-stage なので最終イメージには `dist/` と本番依存のみが入ります
(tsc / devDependencies / tests は含まれません)。

## MCP クライアント登録

先に `npm run build` を実行し、以下のパスを絶対パスへ置き換えます。

### Claude Code

プロジェクトルートの `.mcp.json` に追加:

```json
{
  "mcpServers": {
    "notion-ai": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/NotionAI-MCP/dist/src/index.js"],
      "env": {
        "NOTION_ACCOUNT_FILE": "/absolute/path/account.json"
      }
    }
  }
}
```

または Claude Code の `claude mcp add-json` で同じ stdio 定義を登録できます。

### Cursor

プロジェクト用は `.cursor/mcp.json`、全プロジェクト共通なら `~/.cursor/mcp.json` に追加:

```json
{
  "mcpServers": {
    "notion-ai": {
      "command": "node",
      "args": ["/absolute/path/NotionAI-MCP/dist/src/index.js"],
      "env": {
        "NOTION_ACCOUNT_FILE": "/absolute/path/account.json"
      }
    }
  }
}
```

## ツール

### `notion_ai_chat`

入力:

- `prompt` (必須)
- `model` (任意、Notion 内部 model ID)
- `reasoningEffort` (任意、`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`)
- `conversationId` (任意、過去に返した ID。タイムアウトした chat や再起動前の thread も継続可能)
- `waitSeconds` (任意、1〜55。既定は `NOTION_CHAT_WAIT_MS` の45秒)
- `background` (既定 `false`、`true` で待たずに `jobId` と `conversationId` を即返す)
- `webSearch` / `workspaceSearch` (既定 `true`)
- `readOnly` (既定 `false` = Agent mode。`true` で Notion Ask/read-only mode)
- `fileIds` (任意、`upload_attachment` が返したID。最大19件)
- `attachments` (任意、旧互換のinline text/link context。実ファイルには `fileIds` を使用)

添付なしの新しい chat は実績のある `runInferenceTranscript` workflow thread を使用します。
Agent Serviceでuploadされた`fileIds`は`createAgentThread`の
`content: [{type:"text"}, {type:"file",file_id}]`へ送り、継続ターンは`sendEventToAgentThread`を使います。
Agent Service upload APIが既知のunsupported responseを返した場合、`upload_attachment`の既定`auto` modeは
assistant-transcript uploadへfallbackし、不透明handleを`runInferenceTranscript`の`computer-file` stepへ変換します。
明示的な`inference_transcript` uploadで`processForInference:true`を指定すると、現行Web clientと同じ
`processAgentAttachment`処理完了を待ち、検証済みの`attachment` stepとして送信します。
handleは作成されたthreadに固定され、Agent Service ID・別thread・別workspaceとの混在を拒否し、server再起動・workspace切替で失効します。
同じactive inference conversationへ後からuploadできますが、`conversationId`指定済みの`auto` uploadは、失敗時に別threadへretargetしません。
Agent Service file chatの`policies.approval_mode="ask"`はツール実行時の承認方針であり、`readOnly`のNotion Ask modeとは別設定です。

継続 chat の session は `NOTION_STATE_FILE` に保存され、再起動後も同じ `conversationId` へ送信できます。
保存が無効な場合や別プロセスが作った thread でも、`getInferenceTranscriptsForUser` から thread を引き当てて
session を復元します（`NOTION_SESSION_REHYDRATE=0` で無効化）。復元できない ID は、どの workspace の
thread か分かるエラーを返します。添付 handle は復元対象ではないため、再起動後は再uploadが必要です。

### `list_conversations`

`limit`, `cursor`, `maxPages` を受け取ります。返却された `cursor` は不透明値として次回へそのまま 本ツールが発行していないカーソル (`mcpv1.` 以外や壊れた値) はエラーになります。
渡してください。

### `get_conversation` / `rename_conversation` / `delete_conversation`

`get_conversation` は `conversationId` と任意の `maxPages` を受け取り、hidden thinking、tool call、config/contextなどの運用レコードを返しません。`rename_conversation` は同じworkspace内でthreadの存在を確認後、1行・500 UTF-8 bytes以内の`title`へ変更します。`delete_conversation` は同じ所有権チェックの後、thread recordを`alive: false`へ更新して削除します。誤操作防止のため`confirm: true`が必須で、Notion側で既に削除済みのthreadはno-op（`alreadyDeleted: true`）として返します。 2026-08-26の実アカウント検証では、一時threadが`alive:true`から`false`になり、会話履歴から即時に消えることを確認しました。

### Workspace tools

- `list_workspaces`: `loadUserContent` の `space_views` と `space_view_pointers` が整合し、対応する
  `space` record が存在する workspace だけを返します。
- `switch_workspace`: IDまたは名前で選択し、AI probe成功後にだけ切り替えます。`pin:true` なら
  account JSONにも永続化します。
- `create_workspace`: `/createSpace` を1回だけ呼び、現行Webと同じ`saveTransactionsMain`の3-operation transactionをcommitします。
  `user_root.space_views` と `space_view_pointers` に生成IDがそれぞれちょうど1件あり、さらに
  `syncRecordValuesMain` で完全な `space_view` recordを確認できた場合だけ成功とします。

`/createSpace` 成功後のtransaction・検証失敗はpartial creationです。重複workspaceを防ぐため、
サーバーは `/createSpace` もtransactionも自動再試行せず、切り替え・pin・account JSON更新を行いません。
HTTP errorにはbounded response bodyを含め、`Retry-After` があれば併記します。

### `keep_me_awake` / `check_keep_alive` / `keep_alive_kick` / `stop_keep_me_awake` / `list_keep_alives`

Notion AI は長いタスクの途中でターンを閉じずに止まることがあり、何か送信すれば再開します。`keep_me_awake` はその再開を自動化する見張り役です。保護したい作業の中から、そのチャット自身の `conversationId` を渡して呼びます。

判定は4つの信号で行います。

| 信号 | 中身 |
| --- | --- |
| heartbeat | `thread.updated_time`。最新ステップの `created_time` と一致します |
| stall判定 | `now - updated_time > idleMs`（既定 120s、下限 60s） |
| 正常終了 | `last_turn_outcome.status == "completed"` かつ `completed_time >= anchorTime` → ナッジせず監視終了 |
| 異常停止 | 上記を満たさず heartbeat が止まったもの → ナッジ |

`updated_time` が止まる理由は「正常終了」と「ターン途中死」の2つあり、見た目は同じです。`last_turn_outcome` はターンが閉じたときだけ書かれるので、この2つを分ける唯一の手がかりになります。正常終了のチェックを stall 判定より先に置くのは、閉じたターンも heartbeat を凍結させるためです。逆にすると完了したチャットを永久につつき続けます。

`anchorTime` は登録時の `updated_time` です。ユーザー発言を探しに行かないのは、登録がターンの内側で起きるので安全側に倒れることと、サーバ時刻同士の比較で clock skew を踏まないことの2点が理由です。現在時刻は `syncRecordValuesMain` の `Date` レスポンスヘッダを使います。heartbeat と outcome は同じ 1 回の読み取りから取るので、両者が別のターンを指してしまうことがありません。

新しい指示を投げた直後は `keep_alive_kick` で anchor を打ち直してください。前のターンの完了記録で監視が早期終了するのを防います。

ナッジ本文は `[KEEP-AWAKE n/max]` タグ付きの短文で、「中断箇所から続行」「ユーザーに質問しない」を明記します。素の `continue` を避けているのは、新しい作業を発明されたり質問でターンを潰されたりするためです。`doneToken` を渡すと全ナッジに引用され、監視対象側から完了を申告できます。`message` で本文を差し替えられます。

ナッジは1回ごとに実ターンとしてクレジットを消費します。`maxNudges`、`cooldownSeconds`、`deadlineMinutes` は常に効き、`stop_keep_me_awake` を `keepAliveId` なしで呼べば全停止できます。監視台帳は `state.json` の隣の `keep-alives.json` に永続化され、再起動前から生き残っていたものは `orphaned` として残るので、タイマーが死んだ監視を生きていると見間違えません。

既定値は `NOTION_KEEP_AWAKE_*` で変えられ、`NOTION_KEEP_AWAKE=0` で機能ごと無効化できます。

ロックされた thread へのナッジはそのままでは拒否されるため、lease を握ったまま止まっているターンに対しては送信の直前に自動で中断を行います（`NOTION_KEEP_AWAKE_INTERRUPT=0` で無効化）。送信が空ストリームで拒否された場合も、中断して1度だけ再送します。拒否されたナッジは step を残さないので、再送で作業が二重になることはありません。

### `interrupt_conversation`

Notion は生成中のターンについて thread に `current_inference_id` を立て、その間の追加送信を HTTP 200 のまま空ストリームで拒否します。生成が途中で死んでも lease は残るので、止まったチャットは「送信して起こす」ことすらできません。`interrupt_conversation` は Web クライアントの停止ボタンが永続化しているのと同じ状態変更（`current_inference_id` と `current_inference_lease_expiration` の null 化）だけを行い、thread を再び受信可能にします。専用の停止 endpoint は存在しません。

2026-08-31 の実アカウント検証では、生成中の thread（`current_inference_id` あり）で解除に成功し、直後の同一 thread への送信が拒否されず通ることを確認しました。

まだ書き続けているターンを中断すると残りの出力は失われるため、迷ったら先に `get_conversation` で状況を読んでください。

## ツール注釈（annotations）

全23ツールが MCP の tool annotations（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`）を明示的に宣言します。MCP 仕様の既定値は `readOnlyHint: false` / `destructiveHint: true` / `openWorldHint: true` なので、注釈を省いたツールはクライアントから「書き込み・破壊的」と解釈されます。Notion AI は read tool と write tool の2グループしか持たず（`runReadToolsAutomatically` / `runWriteToolsAutomatically`）、その分類は実質 `readOnlyHint` だけで決まるため、読み取り専用ツールに `readOnlyHint: true` を明示しないと delete 系と区別されません。

| 区分 | ツール | 主な注釈 |
| --- | --- | --- |
| 読み取り専用 | `get_chat_result` `list_chat_jobs` `list_conversations` `get_conversation` `list_workspaces` `get_current_workspace` `list_mcp_connections` `get_mcp_connection_status` `check_mcp_oauth_support` `list_preconfigured_mcp_servers` | `readOnlyHint: true` / `destructiveHint: false` / `idempotentHint: true` |
| 追加のみの書き込み | `upload_attachment` `switch_workspace` `create_workspace` `add_mcp_connection` `start_mcp_oauth` `complete_mcp_oauth` `connect_preconfigured_mcp_server` | `readOnlyHint: false` / `destructiveHint: false` |
| 破壊的 | `notion_ai_chat` `interrupt_conversation` `download_attachment` `rename_conversation` `update_mcp_connection` `remove_mcp_connection` `delete_conversation` | `readOnlyHint: false` / `destructiveHint: true` |

- `notion_ai_chat` は Agent mode（`readOnly: false`）でワークスペースを編集・削除できるため破壊的に分類しています。読み取りだけで使う場合は `readOnly: true` を渡してください。
- `download_attachment` は `overwrite: true` でローカルファイルを上書きできるため破壊的です。
- `delete_conversation` と `remove_mcp_connection` は `idempotentHint: false` にして、ホストの自動リトライ対象にならないようにしています。
- `openWorldHint` は Notion のサーバーに出るツールが `true`、サーバーローカルのジョブ台帳だけを読む `list_chat_jobs` のみ `false` です。
- 注釈は信頼できないヒントに過ぎないため、`delete_conversation` の `confirm: true` ガードは維持しています。
- Notion AI はツールの分類を接続時点で保存します。注釈を変えたらモジュールを再接続（または再承認）しないと古い分類のままになります。

## 60秒タイムアウト対策（job と回収）

Notion AI 側の生成は数分続くことがありますが、MCP client は約60秒で呼び出しを放棄します。
このとき Notion 側では thread が作られて生成が進み、credit も消費されるのに、client には
`MCP error -32001: Request timed out` だけが残り、`conversationId` すら受け取れませんでした。

本サーバーは待ち時間を client 側の制限より短く保ち、答えを job として保持することで取りこぼしを防ぎます。

- `notion_ai_chat` は既定45秒（`waitSeconds` / `NOTION_CHAT_WAIT_MS`、最大55秒）まで待ち、
  終わらなければ `status: "pending"` と `jobId` / `conversationId` を返します。生成はサーバー側で継続します。
- 数分かかると分かっている質問は `background: true` で投げると、待たずに `jobId` と `conversationId` を受け取れます。
- `get_chat_result` は `jobId` または `conversationId` で回答を回収します。job が残っていればそこから、
  無ければ thread 本文（`get_conversation` と同じ user-visible step のみ）から回収します。
- `list_chat_jobs` で job の一覧・状態・prompt preview を確認できます。再起動時に走っていた job は
  `orphaned` として残るので、`get_chat_result` で thread から回収してください。
- job と session は `NOTION_STATE_FILE`（既定 `~/.notion-ai-mcp/state.json`、mode 0600、24時間保持）に
  原子的に保存されます。`NOTION_STATE_FILE=off` で完全にメモリ内のみに切り替えられます。
- client が `progressToken` を送っている場合、10秒ごとに `notifications/progress` を送出して
  進行中であることを伝えます（対応 client は待機を延長できます）。

```jsonc
// 1) 長い質問を投げる（45秒で切り上げ）
{ "name": "notion_ai_chat", "arguments": { "prompt": "...", "model": "gpt-5.4-high", "reasoningEffort": "max" } }
// => { "status": "pending", "jobId": "...", "conversationId": "...", "elapsedMs": 45000, "hint": "..." }

// 2) 回答を回収する（必要なら繰り返す）
{ "name": "get_chat_result", "arguments": { "jobId": "...", "waitSeconds": 30 } }
// => { "status": "completed", "source": "job", "text": "...", "conversationId": "..." }
```

## 検証

```bash
npm run check
npm test
npm run build

# 実アカウントの履歴を本文非表示で smoke test
NOTION_ACCOUNT_FILE=/absolute/path/account.json npm run smoke:live

# 実 chat も行う（Notion 上にテスト thread を作成し quota を消費）
NOTION_ACCOUNT_FILE=/absolute/path/account.json NOTION_SMOKE_CHAT=1 npm run smoke:live
```

内部 API の request/response 仕様は [docs/internal-api.md](docs/internal-api.md)、調査根拠と実環境結果は
[docs/research-and-validation.md](docs/research-and-validation.md) に記録しています。

## モデル指定

`notion_ai_chat` の `model` には、内部 ID・ベンダー名・ティア別名のいずれでも指定できます。
別名テーブルは Notion Web バンドルの model registry から生成した 74 モデル / 235 別名です（`src/models.ts`）。

| 指定例 | 解決される内部 ID |
|---|---|
| `fast` / `default` | `almond-croissant-low`（Sonnet 4.6 Low） |
| `standard` / `balanced` | `almond-croissant-high`（Sonnet 4.6 High） |
| `thinking` / `reasoning` / `deep` | `oatmeal-cookie`（GPT 5.2） |
| `GPT 5.2` / `gpt-5.4` / `gpt-5.4-high` | `oatmeal-cookie` / `oval-kumquat-medium` / `oval-kumquat-high` |
| `Claude Opus 4.5` | `apple-danish` |
| `Gemini 3.5 Flash` | `vertex-gemini-3.5-flash` |
| `Grok 4.5` | `strawberry-whoopiepie` |

別名は大文字小文字・空白・`_`・`()` を無視して照合します。未知の値はそのまま Notion に渡します。
`NOTION_MODEL_ALIASES` の JSON で別名を上書きできます。レジストリの再抽出は `scripts/extract-models.cjs` を使います。

## 思考の深さ（reasoningEffort）

`notion_ai_chat` の `reasoningEffort` は、Notion Web client が thread config に保存するのと同じ
`reasoningEffort` フィールドを、`model` / `modelFromUser` と並べて送信します（Agent Service 経由の
添付 chat では `createAgentThread` / `sendEventToAgentThread` の body に同名フィールドとして付与）。
値を省略した場合はフィールド自体を送らず、Notion 側の既定 effort が使われます。

effort を持つのは Notion の model registry で `modelConfiguration` が定義されたモデルだけです。

| モデル | 指定できる effort | 既定 |
|---|---|---|
| `oatmeal-cookie` (GPT-5.2) / `oval-kumquat` / `oval-kumquat-medium` / `opal-quince` / `opal-quince-medium` | `medium`, `high` | `medium` |
| `oatmeal-cookie-high-thinking` / `oval-kumquat-high` / `opal-quince-high` | `medium`, `high` | `high` |
| `almond-croissant-*` (Sonnet 4.6) / `ambrosia-tart-*` / `acai-budino-high` / `agave-flan` | `low`, `medium`, `high`, `max` | モデル名の tier |
| `orange-mousse` / `orchid-muffin` / `olive-jellyroll` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `vertex-gemini-3.5-flash` | `low`, `medium`, `high` | `low` |
| `grapefruit-zeppole` | `low`, `medium`, `high` | `medium` |

- `High` / `X-High` / `no thinking` / `maximum` などの表記ゆれは正規化して照合します。
- モデルが受け付けない effort（例: `gpt-5.4` へ `low`）や effort picker を持たないモデル（例: `Claude Opus 4.5`）は
  送信前にエラーにし、使える値を提示します。
- 同じ `conversationId` を継続する際に `reasoningEffort` を省略すると、初回に選んだ effort をそのまま引き継ぎます。

## ワークスペース切り替えとクレジット対策

無料プランの AI 応答枚数を使い切ると、ストリームに `premium-feature-unavailable` が流れます。
本実装はこのイベントの `featureAvailability.limit` を読み、`AI credit limit reached: 78/75` のように
実数値を含めたエラーを返します。実際にlimitを返したworkspaceだけを枯渇済みにし、未検証の既存workspaceへ
順番にローテーションします。既存候補を使い切った場合だけ新規workspaceを作成します。
`NOTION_MAX_WORKSPACE_RETRIES=0`で自動ローテーションを無効化できます。conversationまたはfile handleは
workspaceに固定されるため自動ローテーションせず、明示的に切り替えて新規chat/uploadを開始するよう案内します。
手動で回避する場合は `switch_workspace`、必要な場合だけ`create_workspace`を使い、`pin`で固定します。
ただし `/createSpace` は server-side rate limit の対象です。HTTP 429 時は連続実行せず、Notion が返す
`Retry-After`（存在する場合）または十分なcooldownを尊重してください。workspace作成だけ成功して
join transactionが失敗した場合も、自動で再作成せずpartial failureとして調査してください。

注意: 新規 workspace では Custom MCP サーバーが既定で無効のことがあり、`add_mcp_connection` が
`ForbiddenError: Custom MCP servers are disabled for this workspace` で失敗します。その場合は Notion の
ワークスペース設定で有効化してください。

## MCP 接続管理

`add_mcp_connection` は次の 5 段階を順に実行します。

1. `validateMcpConnection`（serverUrl、配列形式のauthHeaders、approval intentでtool一覧を取得）
2. `saveTransactionsFanout`（現行factoryと同じaudit/parent fieldを持つ`workflow_module`を作成）
3. `postWorkflowsMcpServerConnect`（`initiationContext: connect`で接続を確定）
4. `syncRecordValuesMain`（現在の`space_view.settings`と既存Personal Agent moduleを取得）
5. `saveTransactionsFanout`（既存settingsを保持し、`agent_chat_modules`へ新pointerを1回だけ追加）


認証方式は `auth.type` で指定します。

| `auth.type` | 必要フィールド | 送出ヘッダー |
|---|---|---|
| `bearer` | `token` | `Authorization: Bearer <token>` |
| `token` | `token` | `Authorization: Token <token>` |
| `apiKey` | `key`（`headerName` 任意） | `X-API-Key: <key>` または指定ヘッダー |
| `basic` | `username`, `password` | `Authorization: Basic <base64>` |
| `header` | `headers`（任意の map） | 指定したヘッダーをそのまま |
| `oauth` | なし | `start_mcp_oauth` の `browserAuthorizationUrl` を開き、`complete_mcp_oauth` を呼ぶ |
| `none` | なし | なし |

### OAuth start・completion・BYO app

`start_mcp_oauth`はnative redirect flowを開始し、provider直URLに加えてNotionのログイン確認wrapperである`browserAuthorizationUrl`を返します。wrapperをブラウザで開いて認可した後、同じMCP server processで`complete_mcp_oauth`へ`oauthFlowId`を渡します。`waitSeconds`は0〜60秒で、未完了なら`status:"pending"`と次回poll目安を返します。

pending flowはprocess内だけに最大100件・3分間保持し、開始時のworkspace、space view、正規化済みserver URL、display name、transport、tool policyへ束縛します。BYO client credentialやOAuth `connectionId`は保存しません。workspace切り替え、期限切れ、未知・再利用flow、同時finalizerを拒否します。server再起動後はflowを再開できないため、OAuthを開始し直してください。

完了時は`getMcpOAuthFlowResult`の`connectionId`を`validateMcpConnection`へ渡してtoolsを再取得し、認可成功後に新しい`workflow_module`を作成します。現行Notion clientと同様、OAuth開始時のintegration IDとmodule IDは別です。`postWorkflowsMcpServerConnect`には`__oauth_connection_id` pseudo-headerを渡し、Personal Agentへlinkした後、非secret metadataだけをlocal registryへ保存します。途中失敗時は新規moduleをdeactivate/unlinkします。

`existingModuleId`を指定したreconnectでは、開始時と完了時の両方でcurrent workspace・linked module・server URL一致を再検証します。未知のmodule dataを保持し、connect失敗時は直前のdataへrollbackします。`workflowId`付きflowの開始は互換性のため維持していますが、CLI completionは現時点でPersonal Agent moduleだけを対象とし、workflow-scoped flowはNotion UIで完了してください。

`start_mcp_oauth`は`selectedScopes`、`workflowId`、`existingModuleId`、`connectionName`、`transport`、tool policy、`userProvidedOAuthClientId`、`userProvidedOAuthClientSecret`を任意指定できます。scopeはtrim・重複除去し、明示した空配列や空scopeをOAuth開始前に拒否します。BYO client IDとsecretは必ず対で指定し、secretは`initiateMcpOAuth`の1 requestだけに使用してlocal registry、pending flow、module data、戻り値へ保存しません。

認証済みlive pending試験ではAttioのnative flowを開始し、wrapper host/pathとprovider hostを確認してから1回pollし`pending`を取得しました。provider認可は行わず、前後のPersonal Agent module集合、account file hash、local registryが不変であることを確認しました。completed/reconnect/rollback pathは回帰試験で検証し、全103 tests、TypeScript check、build、19-tool compiled stdio smokeが成功しています。

### Preconfigured MCP catalog

`list_preconfigured_mcp_servers`は`getPreconfiguredMcpServers({spaceId})`のraw responseを返さず、ID、表示名、tagline、URL設定、対応認証方式だけをallowlistします。`visibility:"hidden"`は除外し、未知fieldやcredential-like dataは返しません。2026-08-08のlive catalogは21件中20件が表示対象でした。

`connect_preconfigured_mcp_server`はcatalog IDを毎回live catalogで照合し、現行Web clientと同じURL resolverを使います。direct/fixed URL、case-insensitiveなvariant名、`encodeURIComponent`を使うtemplate values、catalog regexで検証するpattern URLに対応します。OAuth catalogでは通常の`initiateMcpOAuth` flowを返し、Bearer/Token/API key等を明示した場合はcustom MCPと同じvalidation → module作成 → connect → Personal Agent link transactionを使います。現行bundleに存在しない`connectPreconfiguredMcpServer` endpointは呼びません。

認証済みcompiled-stdio live試験では20件を列挙し、hidden entry除外とtop-level allowlistを確認しました。AmplitudeのEU variantを解決してOAuth開始に成功し、Personal Agent module集合、account file hash、local registryは不変でした。

### Tool選択と実行確認

`add_mcp_connection.enabledToolNames`にはvalidationで返ったtool名を指定できます。省略時は全tool有効、`[]`は全tool無効です（Notion内部では現行UIと同じ`["__NONE__"]`へ変換します）。`update_mcp_connection`では同じ配列で選択を置換し、`null`でfilterを削除して全tool有効へ戻します。空白はtrim、重複は除去し、未知名はNotionへ書き込む前に拒否します。

`runReadToolsAutomatically`は省略時`true`（read-only toolを確認なしで実行）、`runWriteToolsAutomatically`は省略時`false`（write toolは確認必須）です。write自動実行は明示的に`true`を指定した場合だけ有効になります。`list_mcp_connections`と`get_mcp_connection_status`はeffective policyを返し、`enabledToolNames:null`は全tool有効を意味します。

このserverで作成したcredential-free metadataは `NOTION_MCP_REGISTRY_FILE`（既定はメモリ内のみ）にmode 0600で保存します。`list_mcp_connections`はcurrent `space_view.settings.agent_chat_modules`をsource of truthとしてlinked済み`workflow_module`を1回のbatch requestで取得し、current workspace/viewのlocal metadataだけをmergeします。別clientやUIが作成したmoduleも列挙でき、registryにないauth方式は`unknown`として返します。raw external-connection recordやcredentialは返しません。serverUrlはhttpsまたはlocalhostのみ許可します。

`update_mcp_connection`はlocal registryの有無に依存せず、current Personal Agentにlinkedされたlive MCP moduleをNotionから読み直します。name-only・tool filter・run policy更新は再接続せず、`connectionPointer`、tools、icon、未知fieldを含む既存`data`全体を保持します。serverUrlまたはtransportを変更する場合は`{type:"none"}`を含む明示的authが必須で、先にvalidationし、non-emptyなvalidated toolsだけを反映して`initiationContext:"reconnect"`で再接続します。明示したtool filterは現在または再validation後のtool一覧に照合します。

作成後のconnect、space-view可視化、local registry保存のいずれかが失敗した場合は、作成済みmoduleをdead化し、該当pointerだけをunlinkします。remove時も他のsettingsとmodule pointerを保持します。update/remove/statusはcurrent linkageとlive recordを検証し、local recordが存在する場合はactive workspace/viewとの不一致も拒否します。

Personal Agent moduleには`workflowId`がないため、`get_mcp_connection_status`はworkflow専用の`getMcpOAuthStatus`を呼びません。liveな`workflow_module`、space-view linkage、`external_connection`から`connected` / `needs_reauth` / `needs_setup` / `disconnected`を判定します。2026-08-07のcompiled-stdio DeepWiki試験では、別processでNotion-onlyとして再発見した一時moduleのname-only update、full-data保持、明示的no-auth reconnect、3 tools、cleanup後の`alive:false`・`linked:false`、既存module不変を確認しました。現在の全回帰は103/103です。
2026-08-08の追加live試験では一時DeepWiki moduleに対し、既定policy、1 tool選択、全tool無効、filter削除による全tool復元を順に検証しました。3 toolsとconnected状態を維持し、終了時は一時moduleとregistryを削除、account file hashも不変でした。

## 添付ファイル

実ファイルは次の順で扱います。

1. `upload_attachment` に許可root内の `path`、または `base64` と `fileName` を渡す。
2. 戻り値の `fileId` を `notion_ai_chat.fileIds` に渡す。
3. chat 後は `download_attachment` に `conversationId` と `fileId` を渡して再取得できる。

`upload_attachment.transport`は`auto`（省略時）、`agent_service`、`inference_transcript`を選べます。
`auto`はAgent Serviceを試し、既知の400/404/500/501 generation failureではassistant-transcriptへfallbackします。現行Web bundleからAgent Service upload APIが消えているため、新規uploadで明示した`agent_service`も同じfallbackを行います。
戻り値の`transport`で実際の経路を確認でき、fallback時は同時に返る`conversationId`をchat/downloadへ使用します。

`processForInference:true`は`transport:"inference_transcript"`との組み合わせだけを許可します。
`processAgentAttachment`が返す`task_output`を`complete` / `failed`までpollし、MIME別metadata・guardrail・error codeを
current schemaで検証します。成功時は`processedForInference:true`を返し、chatでは`computer-file`ではなく
processed `attachment` stepを使います。処理待ちは`NOTION_REQUEST_TIMEOUT_MS`で制限され、既定では無効です。

upload例:

```json
{
  "path": "inputs/report.pdf",
  "mimeType": "application/pdf",
  "transport": "inference_transcript",
  "processForInference": true
}
```

chat例:

```json
{
  "prompt": "このPDFを要約して",
  "fileIds": ["<upload_attachment が返した fileId>"]
}
```

download例:

```json
{
  "conversationId": "<file chat の conversationId>",
  "fileId": "<fileId>",
  "outputPath": "downloads/report.pdf",
  "returnBase64": false,
  "overwrite": false
}
```

legacy artifact download例（`conversationId` / `fileId`とは排他的）:

```json
{
  "legacy": {
    "url": "<original Notion file URL>",
    "fileName": "artifact.md",
    "mimeType": "text/markdown",
    "permissionRecord": {
      "table": "thread",
      "id": "<thread UUID>",
      "spaceId": "<active workspace UUID>"
    }
  },
  "returnBase64": false
}
```

legacy modeはHTTPS/root-relative URLに加えてNotionが返す`attachment:<UUID>:<name>` URIを受理し、公式Web clientと同じ `getSignedFileUrls` request（`download:true`）を使います。
permission recordのworkspaceはactive workspaceと一致する必要があり、返されたsigned URLにもtimeout、
redirect拒否、byte上限、安全な出力pathを適用します。downloadしたbytesのSHA-256を常に返します。

upload は `createAgentServiceFileUploadURL` の `single_part` / `multipart` descriptorだけを許可します。
multipartはpart数・一意な連番・file境界・method・URLを**転送開始前に全件検証**し、各partの `ETag` を
`completeAgentServiceFileUpload` に渡します。signed URL requestはredirectを拒否し、
`NOTION_REQUEST_TIMEOUT_MS`でabortします。

upload完了metadataのfile ID・size・任意のSHA-256をローカルbytesと照合します。downloadは
Agent Serviceでは`getFileContentURLForAgentThread`、assistant-transcriptでは公式Web clientと同じ
`app.notion.com/signed/<encoded-source-url>` proxyを使い、`file.notion.com`へのredirectにだけ
`file_token` cookieを転送します。`token_v2`や完全なCookie headerをredirect先へ転送しません。
sizeとSHA-256を実download bytesに対して検証します。ローカルpathは`NOTION_ATTACHMENT_ROOT`の
実パス配下だけ許可し、path traversalとsymlink parentを拒否します。download先を省略した場合は
`downloads/<filename>`、同名ファイルは`overwrite:true`のときだけ置換します。転送前後の両方で
`NOTION_MAX_ATTACHMENT_BYTES`を強制します。

assistant-transcript descriptorはURL、header、form field、chat pointer、count/length、private-network hostを
storage転送前に検証します。proxy redirectもHTTPS・userinfo・private/link-local/metadata hostを再検証します。
`NOTION_FULL_COOKIE`またはaccount JSONの`full_cookie`に`file_token`がない場合、transcript downloadは
明示的な設定errorで停止します。署名URL・S3 policy・一時credential・form fieldは保存も返却もせず、
workspace/thread/file URL/metadata/SHA-256だけを不透明handleに紐づけてメモリ内に保持します。

`fileIds`は空白を除去して重複を排除し、text blockと合わせて最大20 blocksになるよう一意なfileを
19件まで許可します。Agent Service IDとassistant-transcript handleは同一conversation内で混在できません。
旧 `attachments` 入力は互換性のため残していますが、text/URLをprompt contextへ展開するだけです。
Notionへ実ファイルとして送る場合は必ず `upload_attachment` と `fileIds` を使用してください。

## 既知の制限

- 非公式 API のため schema、header、model ID、client version は変更される。
- Node `fetch` は `notion_manager` の Chrome uTLS fingerprint を再現しない。現時点の履歴 API は実環境で成功。
- chat job と継続 session は state file に保存されるが、assistant-transcript upload handle は再起動後に失効する。
- Agent Service file chatのtoken usageはtranscript APIから返らないため、`usage`は現在0を返す。assistant-transcript fallbackは通常の推論usageを返す。
- file chatでは `workspaceSearch` の無効化を明示できず、Agent Serviceのworkspace access既定値を使用する。
- Notion quota がない場合、`premium-feature-unavailable` を tool error として返す。
- browser DOM fallback は持たない。履歴 API が変更された場合は実装更新が必要。
- MCP client の約60秒制限自体は回避できない。長い生成は `pending` job として返り、`get_chat_result` での回収が必要になる。
