# apps/mobile

Flutter(iOS先行)。Riverpod 3 + go_router。

```
lib/src/
  api/             workers/api との通信・匿名デバイスID
  common_widgets/  蛍光マーカー・厚みのあるボタン・後輩の表情
  features/        ドメイン単位(画面単位ではない)
    onboarding/
    capture/       撮影・単元確認
    session/       会話・祝福
    karte/         カルテ・穴・復習・streak(同一ドメインなのでまとめる)
    monetization/  entitlement・ペイウォール
  l10n/            日英2ロケール
  routing/         go_router
  theme/           デザイントークン
```

各featureの中は `presentation / application / domain / data` で分ける
(codewithandrea方式・handoff §5)。

## セットアップ

```bash
flutter pub get
flutter run --dart-define=API_BASE_URL=http://localhost:8787
```

`--dart-define` で渡す値(公開鍵なので秘匿不要):

| 名前 | 用途 |
| --- | --- |
| `API_BASE_URL` | workers/api のURL |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | RevenueCat(iOS) |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | RevenueCat(Android) |

## テスト

```bash
flutter test
```

- `test/contract_fixture_test.dart` — **契約ドリフトの検知**。
  `packages/contract/fixtures/*.json` をDart側のモデルでパースする。
  TypeScript側(`packages/contract/src/fixtures.test.ts`)と両方が通って、
  初めて契約が揃っていると言える。
- `test/widget_test.dart` — 設計上の約束が画面から消えていないかを構造で確かめる
  (ペイウォールの「無料のまま続ける」と「いつでも解約できます」など)。

### golden test について

handoff §5 のテスト方針では主要5画面のgolden testを置くことになっているが、
**このPRの時点ではまだ入れていない**。goldenは丸ゴシックのフォントファイルを
`assets/fonts/` に置いてからでないと、フォント差分で不安定になるため。

フォント配置後の手順:

```bash
flutter test --update-goldens   # CI環境を正として生成する
```

生成はCI(Codemagic)を正とし、ローカルの差分はコミットしない。

## コード生成について(handoff §5からの変更)

handoff は `@riverpod` アノテーション + codegen で統一する方針だったが、
**このPRでは codegen なしのProvider定義と、手書きのモデルにしている**。

理由は、Next Gen Award の要件「リポジトリ単体でプロジェクトが動くこと」に対して、
`dart run build_runner build` を挟まないと `flutter test` すら通らない状態を避けたかったため。
契約ドリフトの検知テストは、クローン直後に走ることに価値がある。

codegenへ寄せる場合、置き換えは機械的:

- `NotifierProvider<X, T>(X.new)` → `@riverpod class X extends _$X`
- 手書き `fromJson` → freezed + json_serializable

判断が要るところなので、方針を戻すなら言ってください。

## 会話が終わったあとの流れ

カルテを作るのはエージェント(サーバ側)なので、アプリは会話が終わったら
`GET /v1/sessions/{id}/result` を見に行く。生成中はサーバが202を返すので、
数秒ポーリングして受け取る。

```
会話終了 → 部屋を切断 → result をポーリング
        → カルテ・進捗を保存 → 祝福 → カルテ
        → (サーバが出すと判断した初回だけ)ペイウォール
```

ペイウォールを出すかどうかは**サーバが決める**(`show_paywall`)。
会話画面のcontrollerはAutoDisposeで、祝福・カルテに着いた時点では
破棄されているので、判断は `sessionOutcomeProvider` に持ち回る。

生成が間に合わなかったときは `resultMissing` を立て、祝福だけ見せる。

## 未実装(次の段階)

- カメラのプレビュー画面(いまは `image_picker` でOSのカメラを呼ぶだけ)
- `resultMissing` のときにカルテを取り直す導線(いまは祝福で止まる)
- OneSignal / Sentry の初期化(鍵が入ってから)
- 会話中の字幕をLiveKitのデータチャネルから受け取る配線
- 効果音・ハプティクス(いまは押下時の `HapticFeedback.lightImpact` のみ)
- Riveによるキャラのステートマシン(v1.1)
