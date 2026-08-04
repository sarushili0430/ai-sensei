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

証明書とプロビジョニングプロファイルを手で作る必要はない。
`codemagic.yaml` の「署名ファイルを取得する(無ければ作る)」ステップが
`app-store-connect fetch-signing-files --create` で発行・更新する。

### 手で作らないこと

Developer Portal の **Generate a Provisioning Profile を手で回さない。**
理由が3つある。

- **配布証明書の秘密鍵が手元に残ってしまう。**
  Mac で作った配布証明書の秘密鍵はそのMacのキーチェーンの中にあり、
  Codemagic からは使えない。`--create` は鍵ごと自分で作るので、
  Codemagic が署名できる状態になる。
- **配布証明書の枠を無駄に食う。** チームで持てる Distribution 証明書には
  上限がある。手で1枚作ってから `--create` させると2枚消費し、
  上限に当たると発行そのものが失敗する。
- **種類を間違えやすい。** 必要なのは
  **Distribution > App Store Connect** のプロファイル。
  Development を選ぶと Select Certificates に開発用証明書しか出ず、
  そのまま作っても `app_store` 配布には使えない。

> **「端末(Device)がリストに無い」は問題ではない。**
> 端末の登録が要るのは Development と Ad Hoc のプロファイルだけで、
> **App Store 配布用のプロファイルは端末を持たない**。
> CIのMacをデバイス登録する必要はない。

### Codemagic UI の「Code signing identities」も使わない

Codemagic UI の
**Available provisioning profiles / Code signing certificates**(iOS側)は、
**手で用意したファイルをアップロードして使う手動署名のための場所**。
`codemagic.yaml` はそちらを参照していないので、ここに何か置いても使われない。

**`--create` が作ったものはこの画面には出てこない。**
プロファイルと証明書は
「Appleの Developer Portal に作られ、ビルドマシンにダウンロードされる」
だけで、Codemagic に保存されるわけではないため。

確認するならこの2か所:

- ビルドログの **「署名ファイルを取得する(無ければ作る)」ステップ**
  — 何を見つけ、何を作ったかが出る
- **[developer.apple.com](https://developer.apple.com) >
  Certificates, Identifiers & Profiles > Profiles**
  — ビルド後に `jp.co.aiSensei` の App Store プロファイルが増えている

> Android の keystore(`ai-sensei-upload-keystore`)は逆で、
> **Codemagic UI に置いたものを使う**。iOS だけAPI経由という非対称になっている。

### 動作確認のためにビルドを回すとき

`ios-testflight` の自動トリガは **`develop` へのpush** だけ。
PRブランチに置いた変更を試したいときは、Codemagic UI の
**Start new build** でブランチと workflow を選んで手動で回す
(`codemagic.yaml` は選んだブランチのものが読まれる)。

> **`environment.ios_signing` の短縮記法と `--create` を併用している。**
> 短縮記法(`distribution_type: app_store` / `bundle_identifier`)は
> 登録済みのプロファイルを**探すだけ**で、無いときに作ってくれない。
> App ID を登録して APIキーに App Manager を与えても、プロファイルが
> 未作成なら `No matching profiles found for bundle identifier ...` で落ちる
> (しかもスクリプトより前の段階なので、ログから理由が追えない)。
> そのため `fetch-signing-files --create` のステップは残してある。
> プロファイルを作り直す必要が出てこのエラーに当たったら、
> `ios_signing` を一時的に外して `--create` のステップだけで回すこと。

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
- **`No matching profiles found for bundle identifier "..." and distribution type "app_store"`**
  → 下の「プロファイルが見つからないとき」を参照。
- **AABがPlayに弾かれる(`not signed`)**
  → keystore の参照名が `ai-sensei-upload-keystore` と一致していない。
    一致しないと `key.properties` が書けず、debug署名にフォールバックする。

## プロファイルが見つからないとき

```
No matching profiles found for bundle identifier "jp.co.aiSensei"
and distribution type "app_store"
```

Codemagic が App Store Connect に「`jp.co.aiSensei` の配布用プロファイルをくれ」と
聞いて、Appleが**何も返さなかった**という意味。

このエラーを出しているのは `environment.ios_signing` の短縮記法で、
あれは登録済みのプロファイルを**探すだけ**。作りはしない。
プロファイルが1度も作られていない状態でこれが出たら、
`environment.ios_signing` を一時的にコメントアウトして回す
—— 後段の `fetch-signing-files --create` がその場で作るので、
1回通れば以降は短縮記法でも見つかるようになる。

`--create` を通しても**作れなかった**場合、確認する順に:

### 1. Identifier が登録されているか(いちばん多い)

**[developer.apple.com](https://developer.apple.com) > Certificates, Identifiers &
Profiles > Identifiers** に `jp.co.aiSensei` があるか見る。

- **大文字小文字が区別される。** `jp.co.aisensei` は別物として扱われ、一致しない
- **Explicit で登録されていること。** ワイルドカード(`jp.co.*`)では
  `app_store` 配布のプロファイルに使えない

> **App Store Connect で「アプリを作成」したことと、
> Developer Portal に Identifier を登録することは別の作業。**
> 手順としては Identifier が先で、アプリレコードはそれを選んで作る。
> アプリレコードだけあって Identifier が無い、という状態にはならないが、
> **どちらも作っていない**場合はここから。

### 2. APIキーとIdentifierのチームが同じか

Apple IDが複数のチームに属している場合、**Issuer ID がチームを決める**。
別チームで Identifier を作っていると、APIキーからは見えないので一致しない。
Identifier のページで所属チームを確認する。

### 3. APIキーの役割

**App Manager 以上**であること。Developer だと読めても**作れない**ので、
同じ「見つからない」エラーになる。役割は後から変更できる。

### 4. 配布証明書の枠

チームの Distribution 証明書が上限に達していると、証明書が作れず失敗する。
Certificates で使っていないものを失効させる。

### ログの読みどころ

「署名ファイルを取得する(無ければ作る)」ステップのログに、
`fetch-signing-files` が
**何を見つけて・何を作ろうとして・なぜ失敗したか**が出る。
上の1〜4はここに理由が出るので、当てずっぽうで潰す必要はない。

`Not enough permissions` のような文言なら 3、
`Bundle ID ... not found` なら 1、
証明書の上限に触れていれば 4。
