# @ai-sensei/api

Cloudflare Workers + Hono。セッション作成・復習問題の保存と採点・課金webhookを担当する。

## エンドポイント

| メソッド | パス | 認証 | 役割 |
| --- | --- | --- | --- |
| POST | `/v1/sessions` | `X-Device-Id` | 写真解析 → 単元判定(**この時点では数えない**) |
| PATCH | `/v1/sessions/{id}/topics` | `X-Device-Id` | チップUIで外した単元を反映する(解析し直さない) |
| POST | `/v1/sessions/{id}/start` | `X-Device-Id` | **会話の開始。日次の持ち時間を仮押さえし**、LiveKitルームとトークンを返す |
| POST | `/v1/sessions/{id}/complete` | `Bearer INTERNAL_API_TOKEN` | agentが呼ぶ。復習問題の保存 + 3日後/7日後のプッシュ予約 |
| GET | `/v1/sessions/{id}/result` | `X-Device-Id` | アプリが会話後に残高と結果を取りに来る(`/complete` 前は202) |
| GET | `/v1/me/progress` | `X-Device-Id` | 連続日数と解けた問題の数 |
| GET | `/v1/me/practice` | `X-Device-Id` | 復習問題のリスト(解きにいく問題 / 解けた問題) |
| POST | `/v1/me/practice/{problemId}` | `X-Device-Id` | テキストの解答を採点し、verdict で通知の段を決める |
| GET | `/v1/me/reviews` | `X-Device-Id` | **@deprecated** 穴ベースの小テスト(ADR 0009。移行期のみ) |
| POST | `/v1/me/reviews/{holeId}` | `X-Device-Id` | **@deprecated** 小テストの自己申告(同上) |
| POST | `/v1/webhooks/revenuecat` | 共有シークレット | entitlement同期 |
| GET | `/health` | なし | 死活確認。どの環境かを名乗る(`{"ok":true,"environment":"production"}`) |

認証は**匿名デバイスID**。アカウント作成を要求しないので、
クライアントが生成したUUIDを `X-Device-Id` で送るだけ。

`/complete` だけは agent が呼ぶ内部エンドポイントで、共有シークレット1本
(`INTERNAL_API_TOKEN`)で通している。**これは静的・無期限・スコープ無しなので、
セッションスコープの短命トークンに移す予定**。当面このままにする判断と、
素直に見えて成立しない経路(LiveKitトークンの `metadata` はアプリから読める)は
[ADR 0003](../../docs/adr.md#adr-0003) に書いてある。

## ローカル開発

```bash
cp .dev.vars.example .dev.vars
pnpm --filter @ai-sensei/api migrate:local   # D1にスキーマを流す
pnpm --filter @ai-sensei/api dev             # http://localhost:8787
```

ローカルではD1/R2/KVをminiflareが偽物で用意するので、**IDの差し替えは要らない**
(`wrangler.toml` のトップレベルが `wrangler dev` 専用の設定になっている)。

## デプロイ

環境は **develop / production の2本**。手順は [`docs/deploy.md`](../../docs/deploy.md)。

```bash
pnpm run deploy:develop      # develop ブランチ相当
pnpm run deploy:production   # main ブランチ相当

pnpm run migrate:develop     # D1のマイグレーション(--remote)
pnpm run migrate:production

pnpm run secret:develop LIVEKIT_API_KEY   # secretは環境ごとに登録する
pnpm run tail:develop                     # ログを流し見る
```

`develop`/`main` へのpushでGitHub Actionsが同じことをやる
([`docs/ci/deploy.yml`](../../docs/ci/deploy.yml))。

**`--env` を付けない `wrangler deploy` は使わない。** トップレベルの名前
(`ai-sensei-api`)で3本目のワーカーができてしまうので、`pnpm run deploy` は
付け忘れとみなして落ちるようにしてある。

`GET /health` は `{"ok":true,"environment":"develop"}` のように環境名を返す。
2本のワーカーは見た目が同じなので、URLの取り違えにこれで気づける。

## 会話の相手(agent)をどう呼ぶか

`POST /v1/sessions/{id}/start` はルーム作成とトークン発行までを行い、**後輩(agent)を
呼ぶのはLiveKit側**。呼び方は2通りあり、ワーカーの登録の仕方で決まる。

| ワーカー | 呼び方 | APIの設定 |
| --- | --- | --- |
| 名前なし | 自動ディスパッチ(全ルーム) | `LIVEKIT_AGENT_NAME` を設定しない |
| 名前つき | 明示ディスパッチ | `LIVEKIT_AGENT_NAME` に同じ名前を入れる |

**LiveKit Cloud のエージェントホスティングは `LIVEKIT_AGENT_NAME` を自動で入れる**
ので、そこに載せたら名前つきになる。名前つきワーカーは自動ディスパッチの
対象外なので、APIが `roomConfig` で呼ばないと**部屋は開くのに誰も来ない**
(アプリは「聞いています」のまま止まり、会話も復習問題も起きない)。

どちらで動いているかは `session_created` ログの `agent_dispatch`
(`explicit` / `automatic`)で分かる。

## ログと監視

Workers の Observability(`wrangler.toml` の `[observability]`)を有効にしてある。
**すべてのログは1行1JSON**で、ダッシュボードでも `wrangler tail` でも
フィールドで絞り込める。

```bash
pnpm run tail:develop
```

| event | いつ | 主なフィールド |
| --- | --- | --- |
| `http_request` | 全リクエストに1行 | `route` `status` `duration_ms` `error_code` |
| `session_created` | セッションを作った | `session_id` `topic_ids` `agent_dispatch` |
| `session_rejected` | 写真が読めない等(想定内) | `session_id` `status` |
| `photo_analysis_failed` | Vision APIが落ちた(想定外) | `session_id` `error_message` |
| `session_completed` | セッションを完了した | `session_id` `ended_reason` `practice_problem` `scheduled` |
| `practice_graded` | 復習問題を採点した | `problem_id` `verdict` `graded_by` `scheduled` |
| `practice_problem_rejected` | 許可集合の外の単元だったので保存しなかった | `session_id` `topic_id` `reason` |
| `complete_unauthorized` | agentの内部トークンがずれている | `session_id` |
| `unhandled_error` | 想定外。アプリには internal_error | `route` `error_stack` |

全レスポンスに `x-trace-id` を返す。ユーザーからの報告とログを突き合わせるのは
この値だけなので、問い合わせ対応ではまずこれを聞く。

`SENTRY_DSN` を登録すると、`unhandled_error` と各 `*_failed` がSentryにも飛ぶ
(未設定なら何も送らず、構造化ログだけ)。写真・問題文・解答・デバイスIDは送らない。
リクエストの1行が邪魔なときは `LOG_LEVEL=error` で失敗だけに絞れる。

## テスト

`pnpm test`(vitest)。**miniflareを起こさずにルートの振る舞いを確かめられる**ように、
永続化・写真解析・通知の3つを差し替え可能にしてある。

```ts
const app = createApp({ services: () => testServices() });
await app.request("/v1/sessions", { method: "POST", body: form }, testBindings());
```

- `repository/memory.ts` — D1の代わり
- `test-support.ts` — 写真解析のスタブ、通知の記録用スケジューラ、バインディング

## 設計上のポイント

**授業枠はサーバで時間として数える。** 無料は**1日1回・最長600秒(10分)**、
Premiumは**1回最長1200秒(20分)で1日3600秒**。授業の中身はプランで変えず、
変わるのは長さと本数だけ。`POST /{id}/start` が残高との小さいほうを
`max_seconds` として1文で仮押さえし、`/complete` が返す `duration_seconds` で精算する。
クライアントの申告から枠を伸ばす道はない。残高が3分未満のときは授業を始めず、
翌日0時(JST)までの秒数を返す。

**無料の「1日1回」は、秒数とは別に回数でも守る**(`freeSessionStartsPerDay`)。
5分で切り上げた人には残高が5分返るので、秒だけを見ていると2本目が始められてしまう。
逆に回数だけにすると10分の枠を守る側が消えるので、**両方要る**。

**ペイウォールを出す位置は「無料で今日の枠を使い切った直後」**(`shouldShowPaywall`)。
`/complete` の応答に `show_paywall` として乗り、アプリは締めの画面から購入画面を開く。
Premium とβ開放中のテスターには出さない(すでに解放されている相手に売り込まない)。

**クローズドβのあいだは、期限つきで全員をPremium相当にする。**
`BETA_OPEN_ACCESS_UNTIL` が入っている間、`hasPremiumAccess` が課金の有無を見ずに
true を返す(持ち時間だけ `BETA_SECONDS_PER_DAY`、既定12000秒)。この期間にアプリを入れられるのは
限定公開テストの名簿に載っている人だけなので、端末IDを1つずつ登録して回らずに済む。
**機能の解放を見る場所はすべて `hasPremiumAccess` を通し、`isPremiumNow` は
「本当に払ったか」を答え続ける** —— 混ぜると、webhookの同期とTRANSFERの期限引き継ぎが
嘘の値を掴む。切り替えかたと外し忘れの危険は [docs/deploy.md](../../docs/deploy.md#クローズドβのあいだ無料で開放する)。

**持ち時間を押さえるのは、先輩と話し始めるとき。写真を読んだときではない。** 以前は解析
(`POST /v1/sessions`)で枠を押さえていたので、撮って単元を確かめただけの生徒が
会話を1度もしないまま「今日はここまで」になっていた。いまは `POST /{id}/start` が
`sessions.started_at` と `max_seconds` を書く1文で枠を押さえ、**確保できたときだけトークンを発行する**。
順番は入れ替えられない — 枠を取れなければ鍵は出ないし、鍵が出たなら枠は取れている。
解析の時点で鍵を配ると「鍵を持っている = いつでも始められる」になり、
数える口をクライアント側に置いたのと同じになる。

つなぎ直しで押し直しても二重には確保しない(`started_at IS NULL` を条件に入れてある)。
数える日(`local_date`)も開始時に書き直すので、日付をまたいで始めた会話は始めた日の時間になる。

**出し直せるのは、最初の鍵が生きているあいだだけ**(`canReissueToken`。上限時間 + 余白)。
無条件に出し直せると、部屋に入らないまま開いたセッションが**期限のない鍵の引換券**になる —
会話が成立しなければ `/complete` も来ない。その場合は窓を過ぎた時点で `max_seconds` を
実績とみなして自動精算し、セッションの押し直しも404にして、
アプリ側にも同じIDを握り続けさせない。

**解析には別の、ずっと緩い上限がある。** 会話を始めなくてもVision LLMの原価は
発生するので、1日に作れるセッション行は `analysesPerDay`(日次時間 ÷ 1回上限 × 5、下限5)で止める。
通常の撮り直しでは当たらない高さで、当たったときの文言は日次上限と同じ。
加えて、今日の授業を使い切っている人は**写真を読む前に**断る(`/v1/sessions` の事前判定)。

**ガードレールは2枚目もここで効かせる。** `/complete` で受け取った復習問題は、
そのセッションの許可トピックで照合する(`filterHoleTopicIds`)。
**外れたら付け替えずに落とす** — 穴は「本人が詰まった事実」だったので主単元へ
付け替えて残していたが、問題にはその事実が無い。付け替えると
「中身は範囲外のまま、タグだけ正しい問題」が3日後に届く。

**復習問題を解くのは無料、音声で先輩を呼び直す授業モードはPremium。**
`/v1/me/practice` は全ユーザーにリストを返すが、`kind=review` の `/v1/sessions` は
サーバ側でもPremiumを要求する。レスポンスのフラグだけに任せると、配った
`problem_id` を使って直接呼べてしまうため。問題の所有者(device_id)も
セッション作成時とトークン発行時の両方で確かめる。

**`/complete` は冪等。** agentがタイムアウトで再送すると、素通しでは問題も
通知予約も二重にできる。判定は `sessions.status === "completed"` —
**保存物の有無では判定できない**(時間切れ・離脱で降りた回は保存物が1つも無い)。

**上限の判定と書き込みは同じ1文にする。** 判定と書き込みが離れていると、同時に2本
投げられたときに両方が同じ残高を見て通る。持ち時間は `started_at` と `max_seconds` を書く
UPDATE の `WHERE` に使用量の集計を入れ、解析枠は条件付きINSERTで押さえる
(SQLiteは1文が原子的なので、同時実行が同じ古い残高を使って両方通れない)。
解析に失敗したら行を消すので、読み取れなかった写真で解析の枠を失うこともない。

**通知の失敗で体験を止めない。** OneSignalの予約に失敗しても、完了応答と採点結果は返す。

**予約を取り消す経路は作らない。** 作成時に決めた段は取り消さない(ADR 0009)。
「3日目に正解したから7日目を消す」をやると「1回言えたら終わり」に戻り、
間隔反復の効き目が消える。旧・穴の予約だけは、埋まったときに取り消す経路が残っている。

**解約予約ではPremiumを剥がさない。** RevenueCatの `CANCELLATION` は解約予約であり、
期限まではPremiumのまま。払ったぶんは最後まで使える、が誠実さ(HAMM)の最低線。

**D1に点数の列を置かない。** `kartes` テーブルにスコア列はなく、
数えるのは連続日数と埋めた穴だけ。

**`locale` は言語だけでなく課程を切り替える。** `POST /v1/sessions` の `locale` は、
Vision LLMに渡すカリキュラムマップ(日本の数学I〜C / 海外の Algebra 1〜)と
プロンプト本体を選ぶ。解析器が別の課程の `topic_id` を返しても落とす。
チップUIに出る科目名も、そのままその課程の言語で返る
([ADR 0005](../../docs/adr.md#adr-0005))。

**穴の言語は `topic_id` から引く。** `locale` をDBに持たない代わりに、
`M2-...`(日本)/ `A2-...`(海外)の接頭辞でその穴の言語が決まる。復習の通知文
(`/complete` で予約)と復習キューの一行(`/v1/me/reviews`)はこれに従うので、
端末の言語設定を変えても、日本語で説明した穴が英語で届くことはない。

## LiveKitトークン

`server-sdk-js` はNode APIに依存するため、WorkersではWebCryptoで
JWT(HS256)を自前で組んでいる(`lib/livekit.ts`)。
トークンの `metadata` に、写真の解釈・許可トピック・質問の種・残り秒数を載せて
エージェントへ渡す。**会話中のガードレールはこのmetadataを基準にする。**
