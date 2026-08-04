# apps/mobile

Flutter(iOS先行)。Riverpod 3 + go_router。

```
lib/src/
  api/             backend/api との通信・匿名デバイスID
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

Flutterのバージョンは **fvm** で固定しています(`.fvmrc` = 3.44.8)。
CIも同じファイルを読むので、手元とCIでSDKがずれません。

```bash
dart pub global activate fvm      # 初回だけ
fvm install                       # .fvmrc のバージョンを取得
fvm flutter pub get
fvm flutter run --dart-define=API_BASE_URL=http://localhost:8787
```

fvmを使わない場合は 3.44.8 を手で入れてください(`flutter --version` で確認)。

### 環境変数

```bash
cp dart_defines.example.env dart_defines.env
fvm flutter run --dart-define-from-file=dart_defines.env
```

ここに入るのは **公開値だけ** です(APIのURL・RevenueCat公開鍵・OneSignal App ID・
Sentry DSN)。`--dart-define` の値はビルド成果物に埋め込まれ、逆アセンブルで読めるので、
**秘密鍵は置かないでください**。秘密鍵はすべて `backend/` 側にあります。

## コード生成

freezed / json_serializable / riverpod_generator を使っています。
**生成物(`*.freezed.dart` / `*.g.dart`)はコミットしません。**
diffが生成物で埋まるとレビューが読めなくなるためです。

```bash
fvm dart run build_runner build            # 一度だけ
fvm dart run build_runner watch            # 開発中
```

クローン直後は `pub get` → `build_runner build` → `flutter test` の順です。
CIも同じ順で走ります。

## テスト

```bash
fvm flutter test
```

- `test/contract_fixture_test.dart` — **契約ドリフトの検知**。
  `packages/contract/fixtures/*.json` をDart側のモデルでパースする。
  TypeScript側(`packages/contract/src/fixtures.test.ts`)と両方が通って、
  初めて契約が揃っていると言える。
- `test/widget_test.dart` — 設計上の約束が画面から消えていないかを構造で確かめる
  (ペイウォールの「無料のまま続ける」と「いつでも解約できます」など)。

### golden test

`test/golden/` に主要6画面(オンボーディング / ホーム / 祝福 / カルテ / 復習 /
ペイウォール)。詳しくは [`test/golden/README.md`](test/golden/README.md)。

丸ゴシック(SIL OFL 1.1)を `assets/fonts/` に置き、テスト側で読み込んでから
描画しています。読み込まないとAhem(四角)で描画され、字形の崩れに気づけません。

## ビルドと配布

`ios/` と `android/` はコミットしています。

| | 識別子 |
| --- | --- |
| iOS | `jp.co.aiSensei`(App Store Connect に登録済み) |
| Android | `jp.co.aiSensei`(初回AABのアップロードまでは変更可) |

配布は Codemagic(リポジトリ直下の `codemagic.yaml`)。
`develop` へのpushで TestFlight に上がります。設定手順は
[`docs/ci/codemagic.md`](../../docs/ci/codemagic.md)。

バージョン名は `pubspec.yaml` の `version` が正で、ビルド番号はCIが振ります。

権限の説明文は `ios/Runner/Info.plist`(カメラ・マイク・写真)と
`android/app/src/main/AndroidManifest.xml` に入れてあります。
リリース署名は `android/key.properties` から読みます(コミットしない。
無ければdebug署名にフォールバックするので `flutter run --release` は動きます)。

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
