# ADR 0003: `/complete` の内部認証は、当面 共有静的トークンのままにする

- ステータス: 承認
- 日付: 2026-08-04
- 関連: [ADR 0002](0002-agent-runtime.md)(agentの稼働先)・`backend/api/src/routes/complete.ts`

## 背景

`POST /v1/sessions/{id}/complete` は agent が会話後にカルテを送るための内部
エンドポイントで、認証は共有シークレット1本になっている。

```ts
// backend/api/src/routes/complete.ts
const authorized = c.req.header("authorization") === `Bearer ${c.env.INTERNAL_API_TOKEN}`;
```

このトークンは **静的・無期限・スコープ無し**で、次の弱点がある。

1. **持っていれば任意の `session_id` に、任意のカルテを、いつまでも書ける。**
   カルテは穴になり、穴は復習通知のスケジュールになるので、アプリの中核データが
   そのまま書き換えの対象になる。
2. **ローテーションが実質回らない。** Workers の secret と agent の環境変数を
   同時に差し替える必要があり、その間 `/complete` は401を返す(=カルテが作られない)。
   手順が重いものは、結局一度も回されない。
3. **置き場所がスタックの最外周。** ADR 0002 のとおり agent は LiveKit Cloud の
   ホスティングか常駐コンテナに置く。長期鍵を、いちばん自分の管理が薄いところに置く形になる。

一方で、**この値はクライアントには渡っていない。** `apps/mobile/dart_defines.example.env`
に入るのは API のURL・RevenueCat公開鍵・OneSignal App ID・Sentry DSN だけで、
`INTERNAL_API_TOKEN` は server↔server 限定である。したがって
「アプリのバイナリに秘密鍵が埋まっている」型の事故ではない。

## 決定

**MVPの提出までは、いまの共有静的トークンのままにする。** そのうえで、
移行先の形と、素直に見えて成立しない経路をここに書き残す。

移行の着手条件は下の「見直す条件」に書く。

## 目標とする形(セッションスコープの短命トークン)

- `POST /v1/sessions` の時点で、そのセッション専用のトークンを発行する
  (`sub = session_id` / `aud = "complete"` / `exp = max_seconds + 生成の猶予`)。
- **署名鍵は Workers だけが持つ。agent は長期鍵を一切持たない。**
- `/complete` は署名・`exp`・`sub` とパスの `session_id` の一致を検証する。

こうすると、漏れたときの被害はそのセッション1本(しかも終わりかけ)に閉じ、
ローテーションも Workers 側の鍵を替えるだけで済む。発行の部品は
`lib/livekit.ts` に WebCrypto の HS256 実装がすでにあるので、新しい依存は要らない。

## 却下した経路: LiveKitトークンの `metadata` に載せる

写真の解釈や許可トピックと同じように、metadata で agent に渡すのが自然に見える。
**これは成立しない。**

```ts
// backend/api/src/lib/livekit.ts
if (input.metadata !== undefined) payload["metadata"] = input.metadata;
```

`metadata` は JWT のクレームであり、その JWT は `livekit.token` として
**アプリにそのまま返している**。JWT は署名であって暗号化ではないので、
アプリは base64 decode するだけで中身を読める。

いま metadata に載っている `photo_summary` / `allowed_topic_ids` / `is_premium` /
`max_seconds` も同じくアプリから見えているが、これらは秘密ではないので設計上は問題ない。
**そこに認証トークンを足すと、アプリが自分のセッションのカルテを偽造できるようになる。**
全体鍵よりは被害が小さいだけで、「サーバから agent へ安全に渡す」にはならない。

したがって移行には **クライアントが読めない経路**が要る。第一候補は LiveKit の
explicit agent dispatch の job metadata(サーバ→agentで、参加者には配られない)だが、
いまは room 作成による自動ディスパッチなので、着手時に可否を確かめる。

## 当面のあいだ守ること

- **`INTERNAL_API_TOKEN` は環境ごとに別の値にする。** develop の agent が
  production の `/complete` を叩けないようにするため(`docs/deploy.md` §2)。
- トークンをログに出さない。エラー時も値を含めない。
- 漏れた疑いがあれば、Workers の secret と agent の環境変数を差し替える。
  差し替えの最中に走っている会話はカルテを落とすが、**会話そのものは成立している**ので
  ユーザーには「あとで結果を見に来ると空」になる。黙って壊すよりは短時間で切り替える。

## 見直す条件

次のどれかに当たったら着手する。

- Shipaton の提出が終わり、W4の磨き込みに入ったとき
- agent の稼働先が決まったとき(ADR 0002 の保留が解けたとき)
- 自分以外の人が agent の実行環境に触るようになったとき

## 結果

- 良い点: MVPの完成を優先できる。認証の作り替えは agent の稼働先が決まってからのほうが、
  経路の選択(job metadata が使えるか)まで含めて一度で決められる。
- 良い点: 素直に見えて成立しない経路(metadata)を先に潰したので、着手時に踏まない。
- 悪い点: それまでのあいだ、agent の実行環境が漏れると **全セッションのカルテを
  偽造できる**状態が続く。被害はデータの汚染であって、ユーザーの個人情報の流出ではない
  (アカウントを持たない設計なので、紐づく個人情報がそもそも無い)が、
  穴と通知が的外れになると、アプリの価値そのものが崩れる。
- 悪い点: 「あとで直す」と書いたものは放置されがちなので、上の見直す条件を
  提出後のタスクに載せておくこと。
