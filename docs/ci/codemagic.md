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

| 変数 | 例 | 要否 | 秘匿 |
| --- | --- | --- | --- |
| `API_BASE_URL` | `https://api.example.workers.dev` | 必須 | 不要 |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | `appl_xxx` | ストアに商品を作ったら | 不要(公開鍵) |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | `goog_xxx` | ストアに商品を作ったら | 不要(公開鍵) |
| `REVENUECAT_SDK_KEY` | `test_xxx` | 上が無い間の代わり | 不要(公開鍵) |
| `REVENUECAT_ENTITLEMENT_ID` | `premium` | 任意(既定 `premium`) | 不要 |
| `REVENUECAT_OFFERING_ID` | | 任意(空なら current) | 不要 |

いずれも `lib/` 側が `String.fromEnvironment` で読む値。
アプリのバイナリに入るものなので、秘密鍵は**絶対にここに入れない**
(LiveKitやLLMのキーはサーバ側 = `wrangler secret` の担当)。

**ストアに商品を作る前でも配布できる。** `appl_` / `goog_` の鍵が発行できるのは
App Store Connect / Play Console に商品を作ったあとなので、それまでは
Test Store の鍵(`REVENUECAT_SDK_KEY`)だけ入れておけばビルドは通る。
アプリ側もプラットフォーム別の鍵が空なら Test Store の鍵に落ちる
(`revenuecat_config.dart` の `apiKeyFor`)。そのビルドは実売ではないので、
1ステップ目のログに警告が出る。

**グループ名は `mobile-dart-defines` と完全一致させ、アプリに紐づけること。**
どちらかを外すと変数が渡らず、ビルドの1ステップ目
「dart-define に渡す環境変数が揃っているか」で落ちる
(そのチェックが無かった頃は、10分以上進んだ最後の
`flutter build` で `API_BASE_URL: unbound variable` になっていた)。

このチェックは**そのworkflowが作る成果物のプラットフォームの鍵だけ**を見る
(iOS workflow なら `appl_`、Android workflow なら `goog_`)。判定には
`codemagic.yaml` の `environment.vars.TARGET_PLATFORM` を使っているので、
workflow を足すときはこの変数も一緒に設定すること。

### `ios-code-signing`(iOSのみ)

| 変数 | 中身 | Secure |
| --- | --- | --- |
| `CERTIFICATE_PRIVATE_KEY` | 配布証明書に埋める RSA 秘密鍵(PEM 全文) | ✅ |

**このリポジトリで唯一、本物の秘密鍵を入れる変数**。作り方と、
渡し忘れると何が起きるかは [2. iOS の署名](#certificate_private_key-が要る)。

### `google-play`(Androidのみ)

| 変数 | 中身 | Secure |
| --- | --- | --- |
| `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` | Play Console のサービスアカウントJSON(丸ごと) | ✅ |

## 2. iOS の署名

**Integrations > Apple Developer Portal > App Store Connect** で
APIキーを登録する。名前は `codemagic.yaml` に書いてある
**`codemagic`** に揃えること(名前で参照している)。
このファイル名と同じ文字列なので紛らわしいが、
指しているのは**APIキーに付けた表示名**のほう。

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
`codemagic.yaml` の scripts の
**`署名ファイルを Apple から取得し Xcode プロジェクトに適用する`** が、
このAPIキーを使って Apple から取得し、無ければ作る。

```
keychain initialize                      # キーチェーンを用意する
app-store-connect fetch-signing-files …  # Appleから取得・生成する
keychain add-certificates                # 証明書をキーチェーンに入れる
xcode-project use-profiles --project …   # Xcodeプロジェクトに適用し
                                         # export_options.plist を作る
```

`use-profiles` に `--project ios/Runner.xcodeproj` を渡しているのは、
省略時の探し方が「クローン先ルートからの `**/*.xcodeproj`」で、
このリポジトリのように iOS プロジェクトが `apps/mobile/ios` にある構成では
見つけられずに素通りすることがあるため。素通りすると
`$HOME/export_options.plist` が作られず、最後の `flutter build ipa` が
`"/Users/builder/export_options.plist" property list does not exist` で落ちる。

### `environment.ios_signing` は使わない

> **`ios_signing` は名前に反して自動署名の設定ではない。**
> あれは「**Codemagic UI にアップロード済みの**署名ファイルから、
> `distribution_type` と `bundle_identifier` に合うものを探して使う」指定
> ([Codemagic Docs](https://docs.codemagic.io/yaml-code-signing/signing-ios/) の
> "uploaded signing files")。**つまり手動署名**で、
> Developer Portal ではなく **UI に置いたファイルが正**になる。

これを自動署名だと誤解していた頃、実際に使われていたのは
Codemagic UI に手でアップロードされた `aisenseiprd` だった。
そのプロファイルは App Groups を持たないまま作られていたので、
NSE が入ったあと

```
Provisioning profile "aisenseiprd" doesn't include the App Groups capability
```

で落ちるようになり、しかも **Developer Portal 側をいくら直しても直らなかった**
—— UI のファイルは Portal とは別物なので、Portal の変更が反映されないため。

`ios_signing` を書き足すと、scripts の `fetch-signing-files` と
**両方式が混ざる**。混ぜると
`No matching profiles found for bundle identifier ... and distribution type "app_store"`
で落ちるので、足さないこと。

### CERTIFICATE_PRIVATE_KEY が要る

変数グループ **`ios-code-signing`** に `CERTIFICATE_PRIVATE_KEY` を
**Secure で**入れておくこと。配布証明書に埋める秘密鍵で、これだけは本物の秘密鍵。

作り方:

```
ssh-keygen -t rsa -b 2048 -m PEM -f ios_distribution_private_key -q -N ""
```

できた `ios_distribution_private_key`(拡張子なしのほう)をテキストエディタで開き、
`-----BEGIN RSA PRIVATE KEY-----` / `-----END RSA PRIVATE KEY-----` の行も含めて <!-- pragma: allowlist secret -->
**全文**を値として貼る。

**渡し忘れると毎ビルド新しい配布証明書が作られる。**
Distribution 証明書はチームで持てる枚数に上限があるので、数回のビルドで
上限に当たり、そこから先は発行そのものが失敗するようになる。
署名ステップの先頭でこの変数を見て、無ければ即座に落とすようにしてあるのはそのため。

### プロファイルは中身まで検査してから使う

### プロファイルは中身まで検査してから使う

同じステップで、`use-profiles` を叩く前に
**プロファイルの Entitlements を読んで**次の2点を見ている。

- 本体(`jp.co.aiSensei`)と **Notification Service Extension**
  (`jp.co.aiSensei.OneSignalNotificationServiceExtension`)の
  プロファイルが**両方**ダウンロードされているか
- そのプロファイルが `Runner.entitlements` の要求する
  **App Group** を許しているか

拡張が入って以降、「プロファイルが1枚でもあればOK」では足りなくなったため。
足りないまま進むと Xcode のアーカイブ(数分)を回しきったあとで

```
Provisioning profile "aisenseiprd" doesn't include the App Groups capability.
Signing for "OneSignalNotificationServiceExtension" requires a development team.
```

になる。直す先は**このリポジトリではなく Developer Portal 側**なので、
検査で落として何が足りないかをログに出すようにしてある。
Portal 側の手順は
[`store-setup.md` の 1-2-1](./store-setup.md#1-2-1-app-group-と拡張ぶんの-identifier)。

### 手で作らないこと

Developer Portal の **Generate a Provisioning Profile を手で回さない。**
理由が3つある。

- **配布証明書の秘密鍵が手元に残ってしまう。**
  Mac で作った配布証明書の秘密鍵はそのMacのキーチェーンの中にあり、
  Codemagic からは使えない。ビルドマシンは証明書本体をダウンロードできても
  鍵が無いので、`Cannot save Signing Certificates without certificate
  private key` で落ちる。
- **配布証明書の枠を無駄に食う。** チームで持てる Distribution 証明書には
  上限がある。手で1枚作ってから CI にも作らせると2枚消費し、
  上限に当たると発行そのものが失敗する。
- **種類を間違えやすい。** 必要なのは
  **Distribution > App Store Connect** のプロファイル。
  Development を選ぶと Select Certificates に開発用証明書しか出ず、
  そのまま作っても `app_store` 配布には使えない。

> **「端末(Device)がリストに無い」は問題ではない。**
> 端末の登録が要るのは Development と Ad Hoc のプロファイルだけで、
> **App Store 配布用のプロファイルは端末を持たない**。
> CIのMacをデバイス登録する必要はない。

**すでに手で作ってしまったプロファイル(例: `aisenseiprd`)は消す。**
自動署名は条件の合う既存プロファイルがあればそれを使い回すので、
残しておくと「Portal の App ID は直したのにビルドだけ落ち続ける」になる
—— プロファイルは**作られた時点の Capability を焼き込んでいる**ため、
App Groups をあとから足しても古いプロファイルには入らない。
**Profiles から消せば**、次のビルドで自動署名が今の Capability で作り直す。

### Codemagic UI の「Code signing identities」は空にしておく

Codemagic UI の
**Available provisioning profiles / iOS certificates**(iOS側)は、
**手で用意したファイルをアップロードして使う手動署名のための場所**。

> **ここに置いたものは「使われない」のではなく、置くと使われてしまう。**
> かつてこのドキュメントには「`codemagic.yaml` は参照していないので置いても
> 使われない」と書いてあったが、**逆**だった。`environment.ios_signing` は
> まさにここを見に行く指定で、実際に手で上げた `aisenseiprd` が
> 毎ビルド使われていた。**Developer Portal を直しても直らない**という
> 厄介な症状の出どころがこれ。

いまは `ios_signing` を書いていないので、この画面のファイルは使われない。
ただし**残っていると次に同じ罠を踏む**ので、iOS のプロファイル・証明書は
削除して空にしておくこと(Android の keystore は別 —— 下記)。

**自動署名が使ったものはこの画面には出てこない。**
プロファイルと証明書は
「Appleの Developer Portal から取得され、ビルドマシンにダウンロードされる」
だけで、Codemagic に保存されるわけではないため。

確認するならこの2か所:

- ビルドログの
  **`署名ファイルを Apple から取得し Xcode プロジェクトに適用する`** ステップ
  — 何を取得し、キーチェーンに何を入れたかが出る
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

> **署名は scripts の `fetch-signing-files` だけでやっている。**
> 一時期これを消して `environment.ios_signing` だけにしていたことがあるが、
> あれは自動署名ではなく UI のファイルを使う手動署名だったので、
> 「Portal を直しても直らない」状態に陥った(上の囲み)。
> かつてこの2つを併用して壊れたのは、
> **手動署名と自動署名を混ぜたから**であって、
> `fetch-signing-files` 側に問題があったわけではない。
> 混ぜないこと。

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

## 8. 位置情報を持ち込まない

### 何が起きたか

TestFlight へのアップロード後、App Store Connect からメールで返ってきた:

```
ITMS-90683: Missing purpose string in Info.plist — Your app's code references
one or more APIs that access sensitive user data. The Info.plist file for the
"Runner.app" bundle should contain a NSLocationWhenInUseUsageDescription key
with a user-facing purpose string ...
```

**ビルドは緑のまま**で、TestFlight にも並ぶ。届くのはアップロードの数十分後なので、
配ったつもりでいるあいだに見落とせる。いまは審査前の警告だが、
放っておくと審査で弾かれる。

### 原因

`onesignal_flutter` が、既定で **OneSignalLocation** をリンクする
(`Package.swift` / `podspec` / `build.gradle` に分岐がある)。
このモジュールが `CoreLocation` を参照するので、
アプリが位置情報を一切使っていなくても Apple の走査には引っかかる。

このアプリで `CoreLocation` を参照しうるものは、確認した範囲でここだけ。
`permission_handler_apple` にも位置情報の実装はあるが、
9.5.0 の `Package.swift` は **Info.plist にキーがあるときだけ**
`PERMISSION_LOCATION` を 1 にするので、いまはコンパイルから外れている。

### どう直したか

用途文言(`NSLocationWhenInUseUsageDescription`)を足すほうは取っていない。

- このアプリは地理での出し分けを一切していないので、**書ける本当のことが無い**
- **App のプライバシー申告で位置情報は「収集しない」**にしてある
  ([`store-setup.md` の 1-7](./store-setup.md))。ここだけ足すと食い違う
- 足すと `permission_handler_apple` 側の位置情報のコードまで復活するので、
  **参照は減るどころか増える**

そこで、モジュールごと外す。両方の workflow の `environment.vars` に

```yaml
ONESIGNAL_DISABLE_LOCATION: "true"
```

を置いてある。`onesignal_flutter` が公式に用意している環境変数で、
`true` か `1` のときだけ効く(大文字小文字は問わない)。

- **iOS** — SwiftPM が `OneSignalLocation` を依存から落とす
- **Android** — `com.onesignal:OneSignal` ではなく
  `core` / `notifications` / `in-app-messages` だけを入れる。
  結果として `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` が
  最終マニフェストから消える(データセーフティ申告と揃う)

アプリ側の `OneSignal.Location.setShared(false)`
(`push_repository.dart`)はそのまま残してある。モジュールが無いビルドでは
素通りするだけで、一段目が外れたときの保険になる。

### 効いたかどうかは毎ビルド検める

`ONESIGNAL_DISABLE_LOCATION` が読まれるのは**依存を解決するとき**で、
解決結果はキャッシュされる。変数が消えたり、キャッシュを持ち回ったりすると
黙って復活する —— そして気づくのは、また数十分後のメールになる。

なので IPA を作ったあとに
**`位置情報のAPIを持ち込んでいないか (ITMS-90683)`** ステップを置いてある。
`.app` の中の Mach-O を全部 `otool -L` にかけ、Apple と同じ規則で判定する:

> `CoreLocation` を参照している **かつ**
> `Info.plist` に `NSLocationWhenInUseUsageDescription` が無い → 落とす

将来ほんとうに位置情報を使うことになったら、用途文言を足せばここは通る。

### 手元で iOS をビルドするとき

同じ変数を**シェルから**渡すこと。Xcode を Dock から起動すると、
シェルの設定は引き継がれない(ターミナルから `open` すること)。

```sh
cd apps/mobile
ONESIGNAL_DISABLE_LOCATION=true flutter build ios
```

すでに一度ビルドしてしまったあとは、解決結果が残っているので効かない。
キャッシュを消してからやり直す:

```sh
cd apps/mobile
flutter clean
rm -rf ios/.build
rm -rf ~/Library/Caches/org.swift.swiftpm ~/Library/Developer/Xcode/DerivedData/*
ONESIGNAL_DISABLE_LOCATION=true flutter build ios
```

Xcode を使うなら **File > Packages > Reset Package Caches** でもよい
(変数を渡した状態で起動していること)。

## つまずきやすいところ

- **`codemagic.yaml` が無視される** → 手順0のYAML切り替えをしていない。
- **`Provisioning profile ... doesn't include signing certificate`**
  → App Store Connect のAPIキーの権限が App Manager 未満。
- **`No matching profiles found for bundle identifier "..." and distribution type "app_store"`**
  → 下の「プロファイルが見つからないとき」を参照。
- **`"/Users/builder/export_options.plist" property list does not exist`**
  → 組み込みの署名ステップが `apps/mobile/ios/Runner.xcodeproj` を見つけられず、
    plist を作らないまま通った状態。scripts の
    `署名をXcodeプロジェクトに適用し export_options.plist を作る` が
    これを埋める(「2. iOS の署名」参照)。
    そのステップが `プロビジョニングプロファイルが1つもダウンロードされていない`
    で落ちるなら、原因は plist ではなく取得側 —— 下の
    「プロファイルが見つからないとき」へ。
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

確認する順に:

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

scripts より前の署名ステップのログに、Codemagic が
**何を見つけて・何を取ろうとして・なぜ失敗したか**が出る。
上の1〜4はここに理由が出るので、当てずっぽうで潰す必要はない。

`Not enough permissions` のような文言なら 3、
`Bundle ID ... not found` なら 1、
証明書の上限に触れていれば 4。

### プロファイルを作り直したいとき

自動署名は**あるものを取ってくるだけ**で、無いものを作らない。
新規に作らせたいときだけ `codemagic.yaml` に一時的にステップを足す:

```yaml
- name: 署名ファイルを作る(一時的に足す)
  script: |
    app-store-connect fetch-signing-files "$BUNDLE_ID" \
      --type IOS_APP_STORE \
      --certificate-key=@env:CERTIFICATE_PRIVATE_KEY \
      --create
```

**`--certificate-key` を省かないこと。** 省くと2つの落とし方をする。

- 既存の配布証明書が Developer Portal にある場合、それを拾うが
  秘密鍵が無いので `Cannot save Signing Certificates without
  certificate private key` で落ちる
- 既存が無い場合は毎ビルド新しい鍵で証明書を作り、
  すぐ枠の上限(4番)に当たる

鍵は1度作って Codemagic の secure な環境変数
`CERTIFICATE_PRIVATE_KEY` に入れ、使い回す:

```
ssh-keygen -t rsa -b 2048 -m PEM -f cert_key -q -N ""
```

作り終わったらこのステップは消す。
