# Notion AI MCP Server

Notion AI の非公式な内部 API を MCP サーバーとしてラップする、個人検証用の TypeScript 実装です。
stdioと認証付きStreamable HTTPの両方で、Claude Code、Cursorなどから次の3ツールを利用できます。

- `notion_ai_chat`: Notion AI にプロンプトを送信し、NDJSON/SSE ストリームを集約して返す
- `list_conversations`: Notion AI の workflow/chat thread をページング取得する
- `get_conversation`: 指定 thread の user-visible な user/assistant メッセージを取得する

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

## 既知の制限

- 非公式 API のため schema、header、model ID、client version は変更される。
- Node `fetch` は `notion_manager` の Chrome uTLS fingerprint を再現しない。現時点の履歴 API は実環境で成功。
- 起動中に作成した thread だけが multi-turn 送信 session として継続可能。
- Notion quota がない場合、`premium-feature-unavailable` を tool error として返す。
- browser DOM fallback は持たない。履歴 API が変更された場合は実装更新が必要。
