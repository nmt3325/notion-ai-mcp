# Notion AI MCP Server

Notion AI の非公式な内部 API を MCP サーバーとしてラップする、個人検証用の TypeScript 実装です。
stdioと認証付きStreamable HTTPの両方で、Claude Code、Cursor、Notion AI 本体などから次の 16 ツールを利用できます。

**チャット / 履歴**

- `notion_ai_chat`: Notion AI にプロンプトを送信し、NDJSON/SSE ストリームを集約して返す（モデル指定・添付対応）
- `list_conversations`: Notion AI の workflow/chat thread をページング取得する
- `get_conversation`: 指定 thread の user-visible な user/assistant メッセージを取得する

**ワークスペース**

- `list_workspaces` / `get_current_workspace`: アカウント内の workspace 一覧と現在の workspace
- `switch_workspace`: space ID または名前（部分一致可）で切り替え、`pin` で固定
- `create_workspace`: 新規 workspace を作成して切り替え（無料枠の AI クレジットをリセットする目的）

**MCP 接続管理（Notion 側の Settings > Connections > MCP を API から操作）**

- `list_mcp_connections` / `add_mcp_connection` / `update_mcp_connection` / `remove_mcp_connection`
- `get_mcp_connection_status` / `check_mcp_oauth_support` / `start_mcp_oauth`
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
`loadUserContent` を使って account/workspace を解決します。

`notion_manager` 互換の account JSON がある場合:

```bash
export NOTION_ACCOUNT_FILE=/absolute/path/to/account.json
node dist/src/index.js
```

環境変数は account JSON より優先されます。完全な一覧は [.env.example](.env.example) を参照。
1アカウントに複数 workspace がある場合、account JSON に保存された既定値とは別の workspace を使うには
`NOTION_SPACE_ID` と `NOTION_SPACE_VIEW_ID` を明示してください。

| 変数 | 必須 | 説明 |
|---|---:|---|
| `NOTION_TOKEN_V2` | 条件付き | `NOTION_ACCOUNT_FILE` に `token_v2` がなければ必須 |
| `NOTION_ACCOUNT_FILE` | 条件付き | `notion_manager` 互換 JSON。token をリポジトリ外に置くことを推奨 |
| `NOTION_SPACE_ID` | 任意 | workspace UUID。未指定時は自動検出 |
| `NOTION_USER_ID` | 任意 | user UUID。未指定時は自動検出 |
| `NOTION_CLIENT_VERSION` | 任意 | 既定 `23.13.20260313.1423` |
| `NOTION_DEFAULT_MODEL` | 任意 | Notion 内部 model ID。既定 `almond-croissant-low` |
| `NOTION_API_BASE` | 任意 | 既定 `https://www.notion.so/api/v3` |
| `NOTION_REQUEST_TIMEOUT_MS` | 任意 | 履歴取得/ストリーム全体の timeout。既定 300000 ms |
| `NOTION_FULL_COOKIE` | 任意 | 必要な場合だけ完全な Cookie header を指定 |
| `NOTION_MODEL_ALIASES` | 任意 | モデル別名を追加/上書きする JSON。例 `{"my-fast":"oatmeal-cookie"}` |
| `NOTION_MCP_REGISTRY_FILE` | 任意 | 登録済み MCP 接続の保存先（mode 0600） |

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

最小のCaddy例:

```caddyfile
notion-ai-mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

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
- `conversationId` (任意、このサーバープロセスが直前に返した ID)
- `webSearch` / `workspaceSearch` (既定 `false`)
- `readOnly` (既定 `true`、Notion Ask mode)

新しい chat は Notion 上に workflow thread を作成します。継続 chat の session は現在メモリ内にだけ
保持するため、サーバー再起動後は以前の `conversationId` を送信継続には使えません。過去 thread の
閲覧は `get_conversation` で可能です。

### `list_conversations`

`limit`, `cursor`, `maxPages` を受け取ります。返却された `cursor` は不透明値として次回へそのまま
渡してください。

### `get_conversation`

`conversationId` と任意の `maxPages` を受け取ります。hidden thinking、tool call、config/context などの
運用レコードは返しません。

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
| `GPT 5.2` / `gpt-5.4-high` | `oatmeal-cookie` / `oval-kumquat-high` |
| `Claude Opus 4.5` | `apple-danish` |
| `Gemini 3.5 Flash` | `vertex-gemini-3.5-flash` |
| `Grok 4.5` | `strawberry-whoopiepie` |

別名は大文字小文字・空白・`_`・`()` を無視して照合します。未知の値はそのまま Notion に渡します。
`NOTION_MODEL_ALIASES` の JSON で別名を上書きできます。レジストリの再抽出は `scripts/extract-models.cjs` を使います。

## ワークスペース切り替えとクレジット対策

無料プランの AI 応答枚数を使い切ると、ストリームに `premium-feature-unavailable` が流れます。
本実装はこのイベントの `featureAvailability.limit` を読み、`AI credit limit reached: 78/75` のように
実数値を含めたエラーを返します。同時に workspace を自動ローテーションして再試行します（`NOTION_MAX_WORKSPACE_RETRIES`）。
手動で回避する場合は `create_workspace` で新規 workspace を作成し、`pin` で固定します。

注意: 新規 workspace では Custom MCP サーバーが既定で無効のことがあり、`add_mcp_connection` が
`ForbiddenError: Custom MCP servers are disabled for this workspace` で失敗します。その場合は Notion の
ワークスペース設定で有効化してください。

## MCP 接続管理

`add_mcp_connection` は次の 3 段階を順に実行します。

1. `validateMcpConnection`（serverUrl と authHeaders で tool 一覧を取得）
2. `saveTransactionsFanout`（`workflow_module` レコードを `module_type: mcp_server` で作成）
3. `postWorkflowsMcpServerConnect`（`initiationContext: connect` で接続を確定）

認証方式は `auth.type` で指定します。

| `auth.type` | 必要フィールド | 送出ヘッダー |
|---|---|---|
| `bearer` / `token` | `token` | `Authorization: Bearer <token>` |
| `apiKey` | `key`（`headerName` 任意） | `X-API-Key: <key>` または指定ヘッダー |
| `basic` | `username`, `password` | `Authorization: Basic <base64>` |
| `header` | `headers`（任意の map） | 指定したヘッダーをそのまま |
| `oauth` | なし | `start_mcp_oauth` で取得した URL をブラウザで開く |
| `none` | なし | なし |

登録済み接続は `NOTION_MCP_REGISTRY_FILE`（既定はメモリ内のみ）に mode 0600 で保存され、
`list_mcp_connections` / `get_mcp_connection_status` から参照できます。serverUrl は https または localhost のみ許可します。

## 添付ファイル

`notion_ai_chat` に `attachments` を渡すと、transcript の user step に添付として付与します。

```json
{
  "prompt": "このメモを要約して",
  "attachments": [{ "name": "notes.md", "text": "..." }]
}
```

添付がある場合は context step の `surface` を `workflows` に切り替えます（UI と同じ振る舞い）。

## 既知の制限

- 非公式 API のため schema、header、model ID、client version は変更される。
- Node `fetch` は `notion_manager` の Chrome uTLS fingerprint を再現しない。現時点の履歴 API は実環境で成功。
- 起動中に作成した thread だけが multi-turn 送信 session として継続可能。
- Notion quota がない場合、`premium-feature-unavailable` を tool error として返す。
- browser DOM fallback は持たない。履歴 API が変更された場合は実装更新が必要。
