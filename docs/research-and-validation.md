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
`Example Workspace` へ切り替えて次を確認した。

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
ローカル回帰は67 testsで、single-part、multipart byte境界、ETag必須、checksum、path traversal、symlink、
byte上限、Agent Service 2-turn file chatに加え、workspace partial commit・delayed visibility・429/502・
no-retryを含めて全件成功した。追加hardeningでは、unknown/duplicate/out-of-range/missing multipart descriptorを
転送前に拒否し、signed request timeout、invalid create/complete response、upload/download size・SHA-256不整合、
19-file上限とdedupe、legacy inline contextとreal-file transport混在拒否を自動検証する。

追加bundle調査では `getSignedFileUrls` のdownload callsiteを12件確認した。artifact/file propertyとも
`{url,download:true,downloadName,permissionRecord}` を送り、responseの `signedUrls[0]` を取得する。
permissionRecordは `{table,id,spaceId}` で、URL batchはspaceIdごとにcell-compatible APIへroutingされる。
この形を `download_attachment.legacy` として実装し、mode排他、HTTPS/root-relative URL、plain filename、
UUID pointer、active-workspace一致、invalid signer response、safe signed GETを回帰化した。

認証復旧後、既存workspaceでAgent Service upload URL作成がHTTP 500、direct thread作成がHTTP 400に
なることを確認した。利用可能quotaを持つ新規workspaceでのupload → file chat → download checksum
lifecycleは、workspace作成rate limitの解除後に行うlive validation項目として残している。

## 2026-08-07 Assistant-transcript upload fallback

認証済みassistant UIが実際に読み込んだ714 JavaScript files（41,916,016 bytes）を`wget`で取得し、
current upload implementationをローカル解析した。ブラウザcaptureでも
`getUploadFileUrlForAssistantChatTranscriptUpload` HTTP 200、S3 multipart/form-data POST HTTP 204、
preview用`getSignedFileUrls` HTTP 200を確認した。requestはthread pointer、content length/type、
UUID upload name、`createThread:true`を含み、responseは`url`, `signedGetUrl`, `signedUploadPostUrl`,
array-shaped `postHeaders`, ordered `fields`, `chatId`を返した。form fieldが先、fileが最後である。

CSV processingでは`processAgentAttachment`の`enqueueTask`がHTTP 200になった一方、240秒後もUIのsend buttonは
disabledのままで、file-backed inference requestは取得できなかった。captureはallowlisted shapeだけをmode 0600で保存し、
raw signed URL、policy、security token、cookie、profile、arbitrary PIIを保持していない。bundleからはprocessed
`attachment` stepとunsupported時の`computer-file` stepを復元したため、現段階のMCP fallbackは後者を使用する。

実装は`auto | agent_service | inference_transcript`選択、既知generation failureだけのauto fallback、
200/204限定S3 POST、header/field/URL/pointer/host検証、redirect/timeout/byte limit、opaque in-memory handle、
thread/workspace/transport isolation、一度だけのtranscript staging、継続partial transcript、署名downloadとSHA-256再検証を追加した。
署名URL・S3 policy・一時credentialは保存・出力しない。自動回帰は70/70 tests、TypeScript check、build、
18-tool compiled stdio smoke、diff/EOF checkに成功した。live upload/chat/download lifecycleは次の検証項目である。

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

## 2026-08-07 Personal Agent MCP persistence live検証

認証済みapp runtimeをread-onlyで調査し、current `workflow_module` factory outputと`space_view.settings.agent_chat_modules` operationを復元した。実装はcreator/editor audit field、`notion_user` parent、1つのshared timestampを含むfactory互換recordを作り、既存settings/module pointerを保持して新pointerを1回だけ追加する。

別processのcompiled stdio serverでDeepWikiを一時追加した結果:

| 対象 | 結果 |
|---|---|
| MCP discovery | 18 tools |
| DeepWiki validation | 成功、3 tools |
| add / list | 成功、local registryに一時recordを確認 |
| status | live module + space-view + external connectionから`connected`を確認 |
| remove | 成功、registryは0件へ復元 |
| remote cleanup | 同じmodule IDが`alive:false`, `linked:false`, `status:disconnected` |
| pre-existing module | 1件を変更せず保持 |
| automated regression | 67/67 tests、TypeScript check/build、compiled stdio smoke成功 |

続くread-only compiled-stdio検証では、local registryが空でもcurrent Personal Agentのlinked module 1件を検出し、alive/linked、3 tool names、`source:notion`、`authType:unknown`を返した。registry fileは作成されず、出力のsecret-like keyは0件だった。

旧status実装はglobal moduleへworkflow専用`getMcpOAuthStatus`を`workflowId`なしで送り400になった。公式UIも`workflowId && moduleId`の場合だけこのrouteを呼ぶため、global module statusはrecord-derivedへ修正した。live harness/resultと認証・bundle調査artifactはrepository外またはignored pathにmode 0600で保持した。

### Notion-only module update / reconnect

環境失効後にpasskey backupから認証sessionを再構築し、5つのdiscoverable workspaceと検証済みPersonal Agent contextを復旧した。別々のcompiled stdio processを使い、既存moduleを変更せずに次を確認した。

1. process Aでunauthenticated DeepWiki moduleを一時追加し、validationで3 tools、statusで`connected`を確認。
2. process Aを停止してlocal registryだけを削除。
3. process Bの`list_mcp_connections`が同じmoduleを`source:notion`、`authType:unknown`として再発見。
4. name-only updateがvalidation/reconnectなしで成功し、name以外の`data`がbyte-equivalentなJSON構造として保持された。
5. 明示的`auth:{type:"none"}` updateがvalidation、full-data merge、`initiationContext:"reconnect"`を実行し、3 toolsと`connected`を維持。
6. remove後は一時moduleが`alive:false`、space-viewで`linked:false`となり、registryは0件へ復元。

前後で既存moduleのdata hash、account credential hash、linked module setが不変であることも確認した。account、registry、live resultはmode `0600`で、raw token、module ID、external-connection recordはログへ保存していない。自動回帰は67/67 tests、TypeScript check、build、18-tool compiled stdio smoke、diff/EOF/credential scanに成功した。

## 2026-08-08 Signed proxy・workspace枯渇追跡のlive検証

新しいLinux/Playwright環境でpasskey backupから認証sessionを復旧し、5 workspaceを再取得した。
assistant-transcript uploadとfile-backed chatは成功したが、`getSignedFileUrls`が返す`file.notion.so` URLの
直接GETは有効期限内でもHTTP 403だった。current bundleのsigned-file helperを再調査し、公式Web clientが
`app.notion.com/signed/<encodeURIComponent(sourceUrl)>`へpermission queryを付けることを確認した。

origin/cookieを分離したlive probeでは、app proxyが`file.notion.com`へHTTP 302を返し、redirectをCookieなしまたは
`token_v2`だけで取得するとHTTP 403、`file_token`だけならHTTP 200かつ元bytes/SHA-256と一致した。実装はproxyへ
認証headerを付け、redirect先がexact `file.notion.com`の場合だけpurpose-specific `file_token`を転送する。任意hostへ
full Cookieや`token_v2`を転送せず、unsafe redirectは接続前に拒否する。18-tool compiled stdioで25-byte CSVの
`auto` fallback upload → opaque handle downloadを実行し、transport、size、bytes、SHA-256がすべて一致した。

workspace probeは`NOTION_MAX_WORKSPACE_RETRIES=0`で5件を明示切り替えし、3件でexact response、2件で
`premium-feature-unavailable`を確認した。最終`list_workspaces`のexhausted flagはlive結果と全件一致し、
利用可能な最後のworkspaceをcurrent/pinnedへ復元した。利用可能workspaceが残るため、新規作成は行っていない。
constructorやrotation targetを先行してexhaustedにする旧挙動を削除し、実際にlimitを返したworkspaceだけを記録する。
workspace-bound conversation/fileは自動rotationせず、新規chat/uploadを要求する。

同じcompiled stdio processで20-byte CSVを`auto` uploadし、file-backed chatのexact marker、proxy downloadの
byte/SHA-256一致、通常名`Claude Opus 4.5`を指定したcontinuationのexact markerまで連続成功した。
最終検証は80/80 tests、TypeScript check、build、18-tool compiled stdio smoke、diff/EOF/credential scanを対象にした。

### Attachment lifecycle boundaryの追加検証

current bundleのmodule `803083`を`wget`取得artifactから再確認すると、assistant-transcript upload helperはactive pointerを受け取る場合も`createThread:true`を送る。したがって既存conversation uploadでもこのwire shapeを保持し、次の`runInferenceTranscript`だけを`createThread:false` / `isPartialTranscript:true`とする。

`conversationId`指定済みのAgent Service upload失敗を新しいtranscript threadへ暗黙fallbackしていた境界を修正した。active conversationへの後続one-shot upload、cross-thread/mixed transport拒否、restart/workspace切替でのhandle失効、unknown handle、HTTP 201 storage拒否を回帰化した。全回帰は80/80 testsである。

compiled stdioのlive試験でも、1つ目のfile upload/chat後、同じ`conversationId`を指定した2つ目の`auto` uploadとfile-backed continuationが同じthreadで成功した。2つ目のfile downloadも元bytes/SHA-256と一致し、18 toolsのまま全exact markerを満たした。

## 2026-08-08 MCP tool filter・run policy bundle調査

Notionの純正web fetchを使わず、`scripts/research-mcp-connections.sh`でlogin HTML、current Rspack runtime、2,079 chunkを`wget`取得した。2,078 chunk（約89.6 MB）を解析し、MCP候補15 sourceを抽出した。current persisted-state schemaは`enabledToolNames?: string[]`を正式に持ち、undefinedは後方互換として全tool有効である。`runReadToolsAutomatically`はundefined/trueで自動実行、`runWriteToolsAutomatically`はtrueだけで自動実行となる。

実装はadd/update schemaにtool filterとread/write policyを追加した。addの安全な既定値はread=true、write=false。current UIは全tool無効を空配列ではなく`["__NONE__"]`で保存する。外部APIの`[]`をこのsentinelへ変換し、`null`はfull `data` setでfieldを削除し全tool有効へ戻す。選択名はtrim・deduplicateし、validation済み/cached catalogにない名前をwrite前に拒否する。name/filter/policyだけの変更はreconnectせず、live `data`全体を保持する。86/86 tests、TypeScript check、build、18-tool compiled stdio smokeが成功した。raw credentialや認証sessionはresearch artifactへ保存していない。

compiled stdioの一時DeepWiki module試験では、既定の全tool、1 tool選択、`["__NONE__"]`による全無効、field削除による全tool復元をlive recordから確認した。最初のprobeで空配列がremoteから消えること、次のprobeでshallow mergeからkeyを省くだけでは既存sentinelが残ることを検出したため、現行UI sentinelへの変換とclear時のfull-data `set`へ修正した。3 tools、connected状態、read/write policyを維持し、一時moduleとmode 0600 registryをcleanupした。account file hashは前後で不変だった。

## 2026-08-08 MCP OAuth BYO app bundle調査

current chunk `11987`の`ConnectMcpServerModal`を再解析した。公式requestは`serverUrl`、`spaceId`、new `integrationId`、optional `workflowId`、resolved `selectedScopes`、`initiationContext`、`callbackType`、`callbackOrigin`、optional `userProvidedOAuthClientId` / `userProvidedOAuthClientSecret`、`approvalIntent`で構成される。既存moduleがある場合だけ`reconnect`となり、global Personal Agentでは`workflowId`を省略できる。`oauth_byo_app` schemeはadvanced settingsを有効化し、custom scopeは空白分割される。

実装はscopeをtrim・deduplicateし、明示的な空選択と100件超を開始前に拒否する。BYO client ID/secretは対でのみ受理し、secretはrequest body以外へ永続化・返却しない。API responseはOAuth flowに必要な4 fieldだけへ縮小し、供給secretがallowlist値へechoされた場合も返却を停止する。reconnectはlive current-workspace MCP moduleとserver URL一致をread-only検証した後だけ許可する。4件のOAuth回帰追加後、全90 tests、TypeScript check、build、18-tool compiled stdio smokeが成功した。


認証済みlive probeではpreconfigured catalog 23 URLを取得し、先頭12 endpointのOAuth discoveryがすべて成功した。Attioは`oauth_dcr`と3 scopesを返した。通常flowと、2 scopes・runtime生成BYO client ID/secretのflowはいずれもAttio authorization URL、completion flow ID、OAuth flow IDを返した。authorization requestにはpublic client IDが反映された一方、client secretは4-field outputに含まれなかった。前後でPersonal Agent module集合とaccount hashは不変、registry fileも作成されず、live resultはmode 0600で保存した。

## 2026-08-08 Preconfigured MCP catalog・標準接続フロー調査

認証済み`getPreconfiguredMcpServers({spaceId})`は21 serverを返し、visibilityはenabled 20 / hidden 1だった。URL設定はdirect 16、variant 3、pattern 1、template 1。current bundle module `166147`はfixed URL、variant index、`encodeURIComponent`したtemplate placeholder、catalog regexのpattern URLを解決する。module `186073`はhidden entryをserver URL setから除外する。2,078 chunk中`connectPreconfiguredMcpServer`は0件で、preconfigured UIもcustom MCPと同じ`Ng` connect actionを呼ぶ。

実装はlive catalogをID/name/tagline/visibility/URL config/auth schemes/scope/approval intentへallowlistし、hidden・malformed・unknown fieldを除外する。catalog IDは接続直前に再取得して照合する。OAuth entryは標準`initiateMcpOAuth`を使い、non-OAuth credentialは既存のvalidation・factory-compatible module・connect・space-view link transactionへ渡す。Token authがserver tool layerでBearerへ誤変換されていた経路も修正し、`Authorization: Token`を保持する。

compiled-stdio live試験では表示対象20件、hidden除外、top-level allowlist、Amplitude 2 variantsを確認した。EU variantは`mcp.eu.amplitude.com`へ解決され、OAuth authorization/completion flowを取得した。前後でPersonal Agent module集合とaccount hashは不変、registry fileは作成されなかった。全95 tests、TypeScript check、build、18-tool stdio smoke、diff/EOF/credential scanが成功した。
