# @ai-sensei/api

Cloudflare Workers + Hono。セッション作成・カルテ保存・課金webhookを担当する。

## エンドポイント

| メソッド | パス | 認証 | 役割 |
| --- | --- | --- | --- |
| POST | `/v1/sessions` | `X-Device-Id` | 写真解析 → 単元判定 → LiveKitルーム作成 + トークン発行 |
| POST | `/v1/sessions/{id}/complete` | `Bearer INTERNAL_API_TOKEN` | agentが呼ぶ。カルテ保存 + 復習プッシュ予約 |
| GET | `/v1/me/progress` | `X-Device-Id` | 連続日数と埋めた穴 |
| GET | `/v1/me/reviews` | `X-Device-Id` | 復習キュー(無料は空 + `requires_premium`) |
| POST | `/v1/webhooks/revenuecat` | 共有シークレット | entitlement同期 |

認証は**匿名デバイスID**(handoff §5)。アカウント作成を要求しないので、
クライアントが生成したUUIDを `X-Device-Id` で送るだけ。

## ローカル開発

```bash
cp ../../.env.example .dev.vars
npm run -w @ai-sensei/api migrate:local   # D1にスキーマを流す
npm run -w @ai-sensei/api dev             # http://localhost:8787
```

D1/R2/KVのIDは `wrangler.toml` にプレースホルダが入っているので、
`wrangler d1 create ai-sensei` などで作ってから差し替える。

## テスト

`npm test`(vitest)。**miniflareを起こさずにルートの振る舞いを確かめられる**ように、
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

**通知の失敗で体験を止めない。** OneSignalの予約に失敗しても、カルテは返す。
穴が埋まったときは、残っている予約を取り消す(埋めた穴について通知が来るのが
いちばん白けるので)。

**解約予約ではPremiumを剥がさない。** RevenueCatの `CANCELLATION` は解約予約であり、
期限まではPremiumのまま。払ったぶんは最後まで使える、が誠実さ(HAMM)の最低線。

**D1に点数の列を置かない。** `kartes` テーブルにスコア列はなく、
数えるのは連続日数と埋めた穴だけ。

## LiveKitトークン

`server-sdk-js` はNode APIに依存するため、WorkersではWebCryptoで
JWT(HS256)を自前で組んでいる(`lib/livekit.ts`)。
トークンの `metadata` に、写真の解釈・許可トピック・質問の種・残り秒数を載せて
エージェントへ渡す。**会話中のガードレールはこのmetadataを基準にする。**
