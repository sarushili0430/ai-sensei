# Codemagic のセットアップ

`apps/mobile` の実機ビルドと配布(TestFlight / Google Play)は Codemagic で行う。
検査(lint / typecheck / test / analyze / golden)は GitHub Actions 側なので、
ここは**配布のためだけ**の設定になっている。

設定の実体はリポジトリ直下の [`codemagic.yaml`](../../codemagic.yaml)。

このページは **Codemagic 側**の設定。受け取る側(App Store Connect / Play Console)で
やること — App ID の Capability、権限、プライバシー申告、定期購入、RevenueCat連携 —
は [`store-setup.md`](./store-setup.md) にまとめてある。

## 0. まず Workflow Editor から YAML に切り替える

Codemagic の初期状態は GUI の Workflow Editor になっている。
このままだと `codemagic.yaml` は読まれない。

**Applications > ai-sensei > Workflow Editor > "Switch to YAML configuration"**

切り替えると `codemagic.yaml` の `workflows:` がそのまま一覧に出る
(`iOS — TestFlight` と `Android — Play internal` の2つ)。
GUI で設定した「Build for platforms」「Run build on」などは、以降は使われない。

## 1. 変数グループ

**Teams/Personal Account > Environment variables** で作る。
どちらも `--dart-define` でアプリに渡る値。

### `mobile-dart-defines`(両workflowが使う)

| 変数 | 例 | 秘匿 |
| --- | --- | --- |
| `API_BASE_URL` | `https://api.example.workers.dev` | 不要 |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | `appl_xxx` | 不要(公開鍵) |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | `goog_xxx` | 不要(公開鍵) |

3つとも `lib/` 側が `String.fromEnvironment` で読む値。
アプリのバイナリに入るものなので、秘密鍵は**絶対にここに入れない**
(LiveKitやLLMのキーはサーバ側 = `wrangler secret` の担当)。

### `google-play`(Androidのみ)

| 変数 | 中身 | Secure |
| --- | --- | --- |
| `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` | Play Console のサービスアカウントJSON(丸ごと) | ✅ |

## 2. iOS の署名

**Integrations > Apple Developer Portal > App Store Connect** で
APIキーを登録する。名前は `codemagic.yaml` に書いてある
**`ai-sensei-asc`** に揃えること(名前で参照している)。

必要なもの(App Store Connect > ユーザーとアクセス > 統合 で発行):

- Issuer ID
- Key ID
- `AuthKey_XXXXXXXX.p8`
- 権限は **App Manager** 以上

発行の手順は
[`store-setup.md` の 1-3-1](./store-setup.md#1-3-1-app-store-connect-api-key-を発行する)
に画面単位で書いてある。**Apple Developer 側の Keys ではなく
App Store Connect 側**という点だけ注意。

署名自体は `codemagic.yaml` の `ios_signing` が自動で取りに行く
(`distribution_type: app_store` / `bundle_identifier: jp.co.aiSensei`)。
証明書やプロファイルを手で作る必要はない。

前提として App Store Connect 側に **同じバンドルIDのアプリレコード**が要る。
無いと `flutter build ipa` は通るがアップロードで落ちる。

## 3. Android の署名

**Settings > Code signing identities > Android keystores** に upload keystore を上げる。
参照名は `codemagic.yaml` の **`ai-sensei-upload-keystore`**。

手元に無ければ作る:

```bash
keytool -genkey -v -keystore upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

ビルド中に `codemagic.yaml` が `apps/mobile/android/key.properties` を書き出し、
`android/app/build.gradle.kts` がそれを読んでリリース署名に使う。
**`key.properties` と `*.jks` はコミットしない**(`android/.gitignore` で除外済み)。

## 4. トリガ

| workflow | いつ走るか | 出るもの |
| --- | --- | --- |
| `ios-testflight` | `develop` へのpush | TestFlight(内部テスター) |
| `android-internal` | `v*` タグ | Play internal トラック(ドラフト) |

READMEのとおり iOS 先行なので、自動で回るのは iOS だけにしてある。
Android は必要になったらタグを打つか、UIから "Start new build" で回す。

`develop` への push ごとに TestFlight に上がるのが多すぎる場合は、
`codemagic.yaml` の `triggering.branch_patterns` を `main` に変えるか、
`events` を `tag` に変える。

## 5. バージョン

- **バージョン名**(`1.2.3` の側)は `apps/mobile/pubspec.yaml` の `version` が正。
  上げたいときはここを編集してコミットする。
- **ビルド番号**は Codemagic の連番(`$PROJECT_BUILD_NUMBER`)で上書きする。
  TestFlightは同じビルド番号の再アップロードを受け付けないため。

## 6. Flutter のバージョン

`apps/mobile/.fvmrc`(= 手元のfvm、= GitHub Actions)が正。
Codemagic は環境変数やファイルからSDKのバージョンを決められないので、
`codemagic.yaml` の `definitions.flutter_version` に**同じ値を手で書いている**。

ズレたときは最初のステップ(`.fvmrc とSDKのバージョンが一致しているか`)で
ビルドが落ちるので、気づかないまま別バージョンで配布することはない。
`.fvmrc` を上げたら `codemagic.yaml` も一緒に上げること。

## 7. golden test を Codemagic では走らせない理由

golden は **Linuxのラスタライズを正**としている
([`apps/mobile/test/golden/README.md`](../../apps/mobile/test/golden/README.md))。
Codemagic は macOS インスタンスなので、そのまま走らせるとフォントの描画差で必ず落ちる。

そのため golden のテストには `golden` タグを付け
(`apps/mobile/test/golden/screens_golden_test.dart` の `@Tags`)、
Codemagic 側は `flutter test --exclude-tags golden` で外している。
golden の正となる実行は GitHub Actions(ubuntu-latest)。

## つまずきやすいところ

- **`codemagic.yaml` が無視される** → 手順0のYAML切り替えをしていない。
- **`Provisioning profile ... doesn't include signing certificate`**
  → App Store Connect のAPIキーの権限が App Manager 未満。
- **`No matching profiles found`**
  → App Store Connect にバンドルIDのアプリレコードが無い。
- **AABがPlayに弾かれる(`not signed`)**
  → keystore の参照名が `ai-sensei-upload-keystore` と一致していない。
    一致しないと `key.properties` が書けず、debug署名にフォールバックする。
