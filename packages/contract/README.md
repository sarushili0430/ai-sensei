# @ai-sensei/contract

`apps/mobile`(Dart)・`backend/api`(TS)・`agent`(TS)の3者をつなぐ契約。
言語をまたぐので「型」ではなく **スキーマとfixture** を正とする。

```
src/         zodスキーマ(TypeScript側の正)
fixtures/    実データのサンプル。TS・Dartの両方のテストがこれをパースする
schema/      zodから生成したJSON Schema(Dart実装時の参照用。コミット済み)
```

## 契約ドリフトの検知

1. `src/fixtures.test.ts` — 全fixtureをzodでパースする(TS側)
2. `apps/mobile/test/contract_fixture_test.dart` — 同じfixtureをfreezedのモデルでパースする(Dart側)
3. `src/json-schema.test.ts` — `schema/*.json` がzodと一致しているか

zodを変えたら:

```bash
pnpm --filter @ai-sensei/contract generate:schema   # schema/*.json を再生成
pnpm test                                          # fixtureとの整合を確認
```

fixtureに新しい形が必要になったら、**fixtureを先に書いてからスキーマを直す**。
fixtureはレビューで一番読まれる場所なので、実際に起きる会話の粒度で書く。

## カルテのスキーマで守っていること

- **点数・正答率のフィールドを持たない。** `strict()` なので、後から `score` を足そうとすると
  テストが落ちる。数えるのは連続日数(`streak_days`)と埋めた穴(`filled_holes`)だけ。
- **穴は最大5件。** カルテを責める道具にしないため、上限をスキーマで縛る。
- **解答・解説の入る場所がない。** `said_well` / `holes` / `term_notes` の3つだけで、
  正しい解法を書き込むフィールドは意図的に用意していない。
- `severity` は復習の並び順にだけ使い、UIには数値として出さない。

## 主なエンドポイント

| メソッド | パス | 誰が呼ぶ |
| --- | --- | --- |
| POST | `/v1/sessions` | mobile(写真 + meta を multipart で) |
| POST | `/v1/sessions/{id}/complete` | agent(内部トークン必須) |
| GET | `/v1/me/progress` | mobile(ホーム画面) |
| GET | `/v1/me/reviews` | mobile(復習画面。無料は `requires_premium: true` で空) |
| POST | `/v1/webhooks/revenuecat` | RevenueCat |

エラーはすべて `{ "error": { "code", "message" } }` の形で返す。
クライアントは `code` で分岐し、`message` はそのまま表示する(煽らない文体で書く)。
