# 自動Continueが動かないとき

## HTTP 200のpermission-denied stub

Notionの`syncRecordValuesMain`は、session失効やworkspaceのアクセス不足でもHTTP 200を返し、
要求したrecordを`{value:{role:"none"}}`だけのplaceholderにすることがある。
HTTP statusやobjectのkey数だけでは、recordを読めたとは判断できない。

以前はこのplaceholderをthreadとして扱い、`updatedTime:null`で`signals_unavailable`となる一方、
watchdogの`lastError`が空だった。また、failed jobの送信確認でこれを「成功した不在確認」と扱うと、
pendingのuser-step/Continue traceを捨て、次回に同じ意図を重複送信し得た。

今回の修正では、idのない`role:"none"` placeholderとそのwrapperを以下で拒否する。

- `threadSignals`: watchdogのprimary signals
- `finalStepShape`: ターンの終了形状
- `nativeContinuationState`: thread、config、iterationの証拠
- `sendChatNudge`: thread/user-stepのreceipt
- native Continueのdelivery: thread/traceのreceipt

エラーには、session失効またはworkspaceアクセス不足の可能性と、`token_v2` / `NOTION_TOKEN_V2`の
更新、server再起動、active workspaceの確認を案内する。watchdogでは`lastError`として表示される。
認証やアクセス権を自動で回避したり、Cookieをログへ出したりしない。

送信receiptが読めない場合、HTTP 200でも成功した不在確認ではない。
failed jobでもpending identityを保持し、読めるrecordで不在を確認するまで再送しない。
単にrecordが存在しない場合のnot-found/null semanticsと、正常なreceiptによるackは従来通り。

## 運用上の復旧

1. デプロイ先のsessionとactive workspaceを確認する。開発用Cookieが有効でも、デプロイ先のCookieが同じとは限らない。
2. 有効なCookieをデプロイ環境のsecret/環境変数またはaccount fileへ安全に設定する。チャットへ貼らない。
3. serverを再起動し、履歴取得などの読み取り操作で認証を確認する。
4. watchdogのdeadline・budget・anchorを確認する。`keep_alive_kick`はanchorを現在のheartbeatへ変えるため、
   古い停止ターンへのnative Continue判定が変わることがある。復旧目的で無条件にkickしない。
5. 有料のContinue/nudgeは明示的な利用判断後に実行する。deadlineが過ぎたwatchdogは自動再開しない。

## 別途残る問題

この修正はrecordの読み取り可否と重複deliveryの保護に限定する。

- `NOTION_REQUEST_TIMEOUT_MS`（既定300000 ms）はstream全体の総時間に適用される。
  継続的に進捗があっても5分でjobがfailedとなり、成功結果後のglobal auto-continue経路を通らない。
  streamのidle timeoutと総時間の上限を分ける変更は別途必要。
- global auto-continueの判定エラーは現在`catch -> break`で部分結果を返す。
- completion inspectorにもエラーを吸収する経路がある。primary signalsのpermission-deniedは
  今回`lastError`へ表出するが、すべてのprobeのエラー可視化はこの修正に含めない。

## 検証

実APIへの有料チャット/Continueは行わず、production client/supervisorをmock fetchで検証した。
新規regressionは修正前に9件失敗し、修正後は該当suiteの69/69件、全体の274/274件が成功。
型チェック、build、compiled stdio smoke、`git diff --check`も成功。
