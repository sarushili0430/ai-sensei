# @ai-sensei/api

Cloudflare Workers + Hono。セッション作成・カルテ保存・課金webhookを担当する。

## エンドポイント

| メソッド | パス | 認証 | 役割 |
| --- | --- | --- | --- |
| POST | `/v1/sessions` | `X-Device-Id` | 写真解析 → 単元判定 → LiveKitルーム作成 + トークン発行 |
| POST | `/v1/sessions/{id}/complete` | `Bearer INTERNAL_API_TOKEN` | agentが呼ぶ。カルテ保存 + 復習プッシュ予約 |
| GET | `/v1/sessions/{id}/result` | `X-Device-Id` | アプリが会話後に結果を取りに来る(生成中は202) |
| GET | `/v1/me/progress` | `X-Device-Id` | 連続日数と埋めた穴 |
| GET | `/v1/me/reviews` | `X-Device-Id` | 復習キュー(無料は空 + `requires_premium`) |
| POST | `/v1/webhooks/revenuecat` | 共有シークレット | entitlement同期 |
| GET | `/health` | なし | 死活確認。どの環境かを名乗る(`{"ok":true,"environment":"production"}`) |

認証は**匿名デバイスID**(handoff §5)。アカウント作成を要求しないので、
クライアントが生成したUUIDを `X-Device-Id` で送るだけ。

`/complete` だけは agent が呼ぶ内部エンドポイントで、共有シークレット1本
(`INTERNAL_API_TOKEN`)で通している。**これは静的・無期限・スコープ無しなので、
セッションスコープの短命トークンに移す予定**。当面このままにする判断と、
素直に見えて成立しない経路(LiveKitトークンの `metadata` はアプリから読める)は
[ADR 0003](../../docs/adr/0003-internal-api-auth.md) に書いてある。

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

`POST /v1/sessions` はルーム作成とトークン発行までを行い、**後輩(agent)を
呼ぶのはLiveKit側**。呼び方は2通りあり、ワーカーの登録の仕方で決まる。

| ワーカー | 呼び方 | APIの設定 |
| --- | --- | --- |
| 名前なし | 自動ディスパッチ(全ルーム) | `LIVEKIT_AGENT_NAME` を設定しない |
| 名前つき | 明示ディスパッチ | `LIVEKIT_AGENT_NAME` に同じ名前を入れる |

**LiveKit Cloud のエージェントホスティングは `LIVEKIT_AGENT_NAME` を自動で入れる**
ので、そこに載せたら名前つきになる。名前つきワーカーは自動ディスパッチの
対象外なので、APIが `roomConfig` で呼ばないと**部屋は開くのに誰も来ない**
(アプリは「聞いています」のまま止まり、会話もカルテも起きない)。

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
| `karte_stored` | カルテを保存した | `session_id` `ended_reason` `holes` `transcript_turns` |
| `complete_unauthorized` | agentの内部トークンがずれている | `session_id` |
| `unhandled_error` | 想定外。アプリには internal_error | `route` `error_stack` |

全レスポンスに `x-trace-id` を返す。ユーザーからの報告とログを突き合わせるのは
この値だけなので、問い合わせ対応ではまずこれを聞く。

`SENTRY_DSN` を登録すると、`unhandled_error` と各 `*_failed` がSentryにも飛ぶ
(未設定なら何も送らず、構造化ログだけ)。写真・カルテ・デバイスIDは送らない。
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

**無料枠はサーバで数える。** 1日1セッション・最長5分の判定は
`lib/entitlement.ts` にあり、クライアントの申告を信用しない。
制限に当たったときは翌日0時(JST)までの秒数を返し、
「また明日、続きを聞かせてください」と言えるようにしている。

**ガードレールは2枚目もここで効かせる。** `/complete` で受け取ったカルテの穴は、
そのセッションの許可トピックで照合し、外れたタグは落とす(`filterHoleTopicIds`)。
的外れなタグを残すと、復習の通知まで的外れになるため。

**復習はサーバ側でもPremiumを要求する。** `/v1/me/reviews` でキューを隠すだけだと、
初回カルテで配った `hole_id` を使って `/v1/sessions` から直接呼べてしまう。
穴の所有者(device_id)もセッション作成時と完了時の両方で確かめる。

**`/complete` は冪等。** agentがタイムアウトで再送すると、素通しではカルテも穴も
通知予約も二重にできる。すでにカルテがあるセッションには、保存済みのものを返す。

**無料枠は行を先に作って押さえる。** 判定と行の作成が離れていると、同時に2本
投げられたときに両方が「今日はまだ0回」を見て通る。写真の解析に数秒かかるぶん
窓が広いので、解析の**前**に行を作る。解析に失敗したら行を消して枠を返すので、
読み取れなかった写真で今日の1回を失うこともない。
(D1にトランザクションがないため、これは窓を数秒からミリ秒に縮める緩和策。
完全な排他が要るなら、`local_date` を含む一意制約で弾く形に寄せる。)

**通知の失敗で体験を止めない。** OneSignalの予約に失敗しても、カルテは返す。
穴が埋まったときは、残っている予約を取り消す(埋めた穴について通知が来るのが
いちばん白けるので)。

**解約予約ではPremiumを剥がさない。** RevenueCatの `CANCELLATION` は解約予約であり、
期限まではPremiumのまま。払ったぶんは最後まで使える、が誠実さ(HAMM)の最低線。

**D1に点数の列を置かない。** `kartes` テーブルにスコア列はなく、
数えるのは連続日数と埋めた穴だけ。

**`locale` は言語だけでなく課程を切り替える。** `POST /v1/sessions` の `locale` は、
Vision LLMに渡すカリキュラムマップ(日本の数学I〜C / 海外の Algebra 1〜)と
プロンプト本体を選ぶ。解析器が別の課程の `topic_id` を返しても落とす。
チップUIに出る科目名も、そのままその課程の言語で返る
([ADR 0005](../../docs/adr/0005-locale-curricula.md))。

**穴の言語は `topic_id` から引く。** `locale` をDBに持たない代わりに、
`M2-...`(日本)/ `A2-...`(海外)の接頭辞でその穴の言語が決まる。復習の通知文
(`/complete` で予約)と復習キューの一行(`/v1/me/reviews`)はこれに従うので、
端末の言語設定を変えても、日本語で説明した穴が英語で届くことはない。

## LiveKitトークン

`server-sdk-js` はNode APIに依存するため、WorkersではWebCryptoで
JWT(HS256)を自前で組んでいる(`lib/livekit.ts`)。
トークンの `metadata` に、写真の解釈・許可トピック・質問の種・残り秒数を載せて
エージェントへ渡す。**会話中のガードレールはこのmetadataを基準にする。**
