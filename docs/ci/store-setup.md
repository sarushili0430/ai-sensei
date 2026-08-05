# ストア側のセットアップ(Apple / Google)

`codemagic.yaml` がビルドしたものを受け取る側の設定。
Codemagic 側の設定は [`codemagic.md`](./codemagic.md)。

| | 識別子 |
| --- | --- |
| iOS | `jp.co.aiSensei` |
| Android | `jp.co.aiSensei` |

---

## 0. 先に決めること

順番を間違えるとやり直しになるものだけ、最初に置く。

### 0-1. 対象年齢に13歳未満(米国は13歳、日本の運用上は未成年)を含めるか

**これが一番効く。** 中高生向けとして「13歳以上」に絞るのと、
小学生を含めるのとで、両ストアの適用ポリシーが変わる。

小学生を含める場合:

- **Apple**: Kids Category 扱い。サードパーティの解析・広告SDKの利用が制限され、
  外部リンクの前に保護者ゲートが要る。**Sentry と OneSignal の扱いを再検討することになる。**
- **Google**: 「ファミリー向けプログラム」が適用。SDKごとに
  ファミリー向け自己申告が要り、広告IDの取得が禁止される。

いまの依存(Sentry / OneSignal)のまま素直に出すなら **13歳以上**。
先に決めないと、審査中に「SDKを外してください」で作り直しになる。

### 0-2. プライバシーポリシーのURL

**両ストアで必須。** ページが無いと審査に出せない。
写真・音声・匿名デバイスIDを何のために集めて、どこに置いて、いつ消すかを書く。

### 0-3. 写真と会話の保持期間

申告(1-7 / 2-6)の内容がここで決まるので、先に方針を決める。
現状のコードを読むと:

- ノート写真は R2 に `photos/{deviceId}/{sessionId}` で**保存されたまま**
  (`backend/api/src/routes/sessions.ts:105`)。削除処理は見当たらない。
- 会話の文字起こしはカルテ生成に使われる(`backend/agent/src/transcript.ts`)。

「消さない」なら消さないと申告すればよく、それ自体は違反ではない。
ただし**申告と実装が食い違うのが一番まずい**(両ストアとも公開停止の理由になる)。

### 0-4. 定期購入の内容

価格・期間(月額か年額か)・無料トライアルの有無。
両ストアとRevenueCatの3か所に同じものを作るので、先に紙で決めておく。

---

## 1. Apple

### 1-1. Apple Developer Program

年間 $99(法人は D-U-N-S 番号が要り、発行に数日〜数週かかる)。
Organization で取るなら**ここが律速**なので最初に着手する。

### 1-2. Certificates, Identifiers & Profiles → Identifiers

**Identifiers > + > App IDs > App** で `jp.co.aiSensei` を **Explicit** で作る。

> **これは 1-4 の「アプリを作成」とは別の作業で、こちらが先。**
> Identifier が無いと Codemagic の署名が
> `No matching profiles found for bundle identifier ...` で落ちる。
> 自動署名はプロファイルと証明書を作れるが、**Identifier の登録はしてくれない**。
> 大文字小文字も区別されるので、`jp.co.aisensei` ではなく
> `jp.co.aiSensei` で登録すること。

Capabilities のうち、このアプリで**触るもの**:

| Capability | 設定 | 理由 |
| --- | --- | --- |
| In-App Purchase | 有効(既定で有効) | `purchases_flutter` |
| Push Notifications | **有効にする** | `onesignal_flutter`。既定はオフ |

**触らないもの**(付けると審査で用途を聞かれるだけ損):

Sign in with Apple(アカウントを作らない)、Associated Domains、
HealthKit、Maps、Wallet、iCloud、Game Center、NFC、
Apple Pay — いずれも未使用。

> Background Modes は App ID の Capability ではなく Info.plist / Xcode 側の設定。
> 1-9 を参照。

### 1-3. 鍵は3種類ある(まず違いを押さえる)

`.p8` という同じ拡張子のファイルが3つ出てくるうえ、**発行する場所がそれぞれ違う**。
ここを取り違えるのが一番よくある事故なので、先に整理しておく。

| 鍵 | どこで作る | 用途 | 渡す先 |
| --- | --- | --- | --- |
| **App Store Connect API Key** | App Store Connect > ユーザーとアクセス > 統合 | ビルドの署名とアップロード | Codemagic |
| In-App Purchase Key | 同上(別タブ) | 課金レシートの検証 | RevenueCat(1-10) |
| APNs Auth Key | **Apple Developer**(別サイト)> Keys | プッシュ通知 | OneSignal |

いま要るのは**一番上の App Store Connect API Key** だけ。

> **よくある間違い**: Apple Developer(developer.apple.com)の
> 「Certificates, Identifiers & Profiles > Keys」で作れるのは APNs の鍵などで、
> **App Store Connect API Key はここには無い**。
> 別サイトの App Store Connect(appstoreconnect.apple.com)で作る。

### 1-3-1. App Store Connect API Key を発行する

#### 手順

1. **[appstoreconnect.apple.com](https://appstoreconnect.apple.com)** にサインインする
2. 上部の **「ユーザーとアクセス」**(Users and Access)を開く
3. タブの **「統合」**(Integrations)を選ぶ
4. 左のリストで **「App Store Connect API」** を選ぶ
5. **「チームキー」**(Team Keys)タブにいることを確認する
   - 「個別キー」(Individual Keys)は個人に紐づく鍵。
     **CIには使わない**(その人がチームを抜けると鍵ごと死ぬ)
6. **「+」** ボタンを押す
7. 入力する

   | 項目 | 値 |
   | --- | --- |
   | 名前 | `Codemagic` など、後で見て分かるもの(自由) |
   | アクセス(役割) | **App Manager** |

8. **「生成」**(Generate)を押す

#### 控えるもの(3点セット)

生成後の一覧画面から、以下の3つを取る。**Codemagic にはこの3つを入れる。**

| | どこにあるか | 形 |
| --- | --- | --- |
| **Issuer ID** | ページ**上部**に1行で表示(キーの一覧の外) | `6a7b...` のようなUUID |
| **Key ID** | 作った鍵の行 | 10文字の英数字 |
| **APIキー(.p8)** | 行の右端「APIキーをダウンロード」 | `AuthKey_XXXXXXXXXX.p8` |

> **`.p8` は一度しかダウンロードできない。**
> 閉じると二度と取れないので、その場でパスワードマネージャ等に保管する。
> 無くしたら失効させて作り直す(作り直し自体は何度でもできる)。

> **Issuer ID を取り忘れやすい。** 鍵ごとではなくチームに1つで、
> 一覧の上に小さく出ているだけなので見落としやすい。

#### 詰まったら

- **「統合」タブが無い / 「+」が押せない**
  → 権限不足。**Admin または Account Holder** でサインインする必要がある。
- **初回だけ「アクセスをリクエスト」ボタンしか出ない**
  → チームキーの利用開始は **Account Holder 本人**が押す必要がある。
    別の人が Account Holder なら、その人に踏んでもらう。
- **役割を Developer にしてしまった**
  → Codemagic のビルドが
    `Provisioning profile ... doesn't include signing certificate` で落ちる。
    役割は後から変更できるので、**App Manager** に上げる。

### 1-3-2. Codemagic に登録する

1. Codemagic の **Settings**(または左下の Account settings)>
   **Integrations** > **Developer Portal** を開く
2. **Manage keys / Add key** から新規登録
3. 入力する

   | 項目 | 値 |
   | --- | --- |
   | **名前** | **`codemagic`** |
   | Issuer ID | 1-3-1 で控えたUUID |
   | Key ID | 1-3-1 で控えた10文字 |
   | API key | `AuthKey_XXXXXXXXXX.p8` をアップロード |

> **名前は `codemagic` にすること。**
> `codemagic.yaml` の `integrations.app_store_connect: codemagic` が
> この名前で参照している。違う名前にするなら yaml 側も直す。
>
> **ファイル名と同じ文字列だが別物。** ここで言う `codemagic` は
> 「このAPIキーに付けた表示名」であって、`codemagic.yaml` のことではない。
>
> **Code signing identities の証明書名とも別物。**
> あちらは手でアップロードした証明書ファイルの名前で、
> `integrations.app_store_connect` からは参照できない。
> 証明書名(`aisenseidist` など)を書くと
> `App Store Connect integration "..." does not exist` で落ちる。

登録できていれば、証明書(Certificates)とプロビジョニングプロファイルを
**手で作る必要はない**。`codemagic.yaml` の `ios_signing` が
このAPIキー経由で自動発行・自動更新する。

### 1-3-3. APNs Auth Key(プッシュを配線するときだけ)

いまは OneSignal が未実装なので後回しでよい。

**[developer.apple.com](https://developer.apple.com) > Certificates, Identifiers &
Profiles > Keys > +** で、
「**Apple Push Notifications service (APNs)**」にチェックして作る。
こちらの `.p8` も再ダウンロード不可。

OneSignal には `.p8` + **Key ID** + **Team ID** + **Bundle ID**(`jp.co.aiSensei`)を入れる。
Team ID は Apple Developer の右上、またはメンバーシップのページで確認できる。

### 1-4. App Store Connect にアプリを作る

**My Apps > + > New App**

| 項目 | 値 |
| --- | --- |
| プラットフォーム | iOS |
| 名前 | ストア表示名(30字以内、日本語可) |
| プライマリ言語 | 日本語 |
| バンドルID | `jp.co.aiSensei`(1-2 で作ったもの) |
| SKU | 任意の内部ID(例 `ai-sensei-ios`) |

**これを作らないと Codemagic のアップロードが落ちる**
(ビルド自体は通るので気づきにくい)。

### 1-5. 契約・税務・銀行

**Business(旧 Agreements, Tax, and Banking)**

「有料App契約(Paid Applications Agreement)」を**有効にする**。
これが未締結だと定期購入の商品が作れず、作れても Sandbox で買えない。
銀行口座と税務情報の入力が要るので、**法人の場合は経理待ちになりがち**。
0-1 と並んでリードタイムが長いので早めに着手する。

### 1-6. サブスクリプションを作る

**アプリ > 収益化 > サブスクリプション**

1. サブスクリプショングループを作る(例 `ai-sensei Premium`)
2. その中に自動更新サブスクリプションを作る
   - 商品ID(例 `jp.co.aisensei.premium.monthly`)— **後から変更できない**
   - 期間・価格
   - 表示名と説明(ローカライズ。日本語は必須)
3. **審査用スクリーンショット**(ペイウォール画面)を添付 — 無いと審査で弾かれる
4. 無料トライアルを付けるなら「サブスクリプション特典」から追加

### 1-7. App のプライバシー

**アプリ > App のプライバシー**。コードから見て申告すべきものは以下。

| データ種別 | 収集 | 用途 | 個人と紐づくか | 根拠 |
| --- | --- | --- | --- | --- |
| 写真 | する | Appの機能 | **紐づく**(匿名デバイスIDと対) | `api_client.dart` が multipart で送信、R2に保存 |
| 音声データ | する | Appの機能 | 紐づく | `livekit_client` で会話を送る |
| ユーザーID | する | Appの機能 | 紐づく | `device_id.dart` の匿名UUID |
| 購入履歴 | する | Appの機能 | 紐づく | `purchases_flutter` |
| クラッシュデータ | する | 分析 | 紐づかない設定にできる | `sentry_flutter` |
| その他の使用状況データ | する | Appの機能 | 紐づく | カルテ(学習の記録) |

**申告しないもの**: 氏名・メールアドレス・電話番号・住所・位置情報・連絡先・
健康・金融情報。いずれもアプリが取得していない(アカウントを作らないため)。

**「トラッキング」は「なし」**。広告ID(IDFA)を使っておらず、
データを第三者の広告目的に渡していないため。
したがって `NSUserTrackingUsageDescription` と ATT ダイアログも不要。

> `device_id.dart` のIDはアプリが自分で作るUUIDで、広告IDではない。
> それでも Apple の定義では「ユーザーID」に当たるので**申告は要る**。

### 1-8. 年齢制限(Age Rating)

**アプリ > 一般情報 > 年齢制限** のアンケートに答える。
0-1 で「13歳以上」に決めたなら、Kids Category には**入れない**。

### 1-9. Info.plist(アプリ側・リポジトリで管理)

すでに入っているもの:

| キー | 値の意味 | 由来 |
| --- | --- | --- |
| `NSCameraUsageDescription` | ノートの撮影 | `camera` / `image_picker` |
| `NSMicrophoneUsageDescription` | 声で説明してもらう | `livekit_client` |
| `NSPhotoLibraryUsageDescription` | 撮影済みの写真を選ぶ | `image_picker` |
| `ITSAppUsesNonExemptEncryption` = `false` | 輸出コンプライアンスの手入力を省く | HTTPSのみ |

**プッシュを配線するとき**に追加が要るもの(いまは未実装):

- Xcode の Signing & Capabilities で **Push Notifications** を追加
  → `Runner.entitlements` に `aps-environment` が入る
- `UIBackgroundModes` に `remote-notification`

**画面ロック中も会話を続けたいなら**さらに:

- `UIBackgroundModes` に `audio`
- 審査で用途を必ず聞かれる。会話アプリなので説明はつくが、
  「不要なら付けない」が安全

### 1-10. RevenueCat(Apple側)

1. RevenueCat のプロジェクトに App Store のアプリを追加し、Bundle ID を入れる
2. **In-App Purchase Key**(App Store Connect > Users and Access > Integrations >
   In-App Purchase)を作って RevenueCat にアップロード
3. **App Store Server Notifications V2** の URL に RevenueCat のURLを設定
   (App Store Connect > アプリ > 一般情報)
4. Products に 1-6 の商品IDを登録
5. **Entitlements に `premium` を作る**(identifier のほう。表示名は自由)。
   アプリ側の既定値は `revenuecat_config.dart` の `entitlementId`。違う名前に
   したいときは `--dart-define=REVENUECAT_ENTITLEMENT_ID=...` で合わせる。
   ずれると**課金は成立するのに何も解放されない**
6. **Offerings で `current` を設定し、パッケージを 週/月/年 の3つ入れる** —
   識別子は RevenueCat の定型(`$rc_weekly` / `$rc_monthly` / `$rc_annual`)。
   current が空だとペイウォールに商品が出ない
7. **Paywalls でペイウォールを作る**(Offering に紐づく)。作らないと
   アプリは自前のペイウォールに落ちる — 詳細は [`docs/revenuecat.md`](../revenuecat.md)
8. 公開SDKキー(`appl_...`)を Codemagic の変数グループ `mobile-dart-defines` の
   `REVENUECAT_IOS_PUBLIC_SDK_KEY` に入れる
9. Webhook を `https://<api>/v1/webhooks/revenuecat` に向け、
   Authorization ヘッダに `REVENUECAT_WEBHOOK_AUTH` と同じ値を設定
   (`backend/api/src/routes/webhooks.ts:41`)

### 1-11. TestFlight

内部テスターは App Store Connect のユーザーを追加するだけで、審査なしで配れる
(最大100人)。外部テスターは初回にベータ版審査が要る。

`ITSAppUsesNonExemptEncryption` を入れてあるので、
アップロードのたびに輸出コンプライアンスを聞かれることはない。

**ベータ版アプリ情報**(説明・フィードバックメールアドレス・ベータ版App Review情報)に
貼るテキストは [`docs/testflight.md`](../testflight.md) に用意してある。
フィードバック先は `SUPPORT_EMAIL` と同じアドレスにすること。

---

## 2. Google

### 2-1. Google Play Console

登録料 $25(買い切り)。法人アカウントは D-U-N-S と本人確認が要る。
個人でも**住所・電話の確認**があり、完了まで数日かかることがある。

### 2-2. アプリを作成

**すべてのアプリ > アプリを作成**

| 項目 | 値 |
| --- | --- |
| アプリ名 | ストア表示名 |
| デフォルトの言語 | 日本語 |
| アプリ / ゲーム | アプリ |
| 無料 / 有料 | **無料**(アプリ内購入あり) |

> **有料→無料の変更はできない。** 定期購入は「無料アプリ + アプリ内購入」で作る。

パッケージ名 `jp.co.aiSensei` は**最初のAABをアップロードした時点で確定**し、
以後変えられない。

### 2-3. 署名(Play App Signing)

**リリース > 設定 > アプリの署名**

初回アップロード時に Play App Signing が自動で有効になる。
Codemagic に置いた upload keystore は「アップロード鍵」であって、
配信用の署名鍵はGoogleが持つ。**upload keystore を失くすと再発行申請が要る**ので、
`.jks` とパスワードは Codemagic 以外にも保管しておく。

### 2-4. 内部テスト

**テスト > 内部テスト > 新しいリリースを作成**

`codemagic.yaml` の `android-internal` が `track: internal` に上げる。
テスターはメールアドレスのリストで登録(最大100人、審査なし)。

**ただし初回だけは手でAABをアップロードする必要がある。**
アプリが1度も公開されていない状態だと、APIからのアップロードが弾かれる。

### 2-5. アプリのコンテンツ(必須の申告)

**ポリシー > アプリのコンテンツ**。全部埋めないとリリースできない。

| 項目 | このアプリの答え | 理由 |
| --- | --- | --- |
| アプリのアクセス権 | 制限なし | アカウントを作らないので全機能が最初から使える |
| 広告 | 広告なし | 広告SDKを入れていない |
| コンテンツのレーティング | IARCのアンケートに回答 | 教育アプリ。暴力・性的表現なし |
| ターゲット層と コンテンツ | **0-1 で決めた年齢層** | 13歳未満を含めるとファミリー向けポリシー適用 |
| データセーフティ | 2-6 参照 | |
| ニュースアプリ | いいえ | |
| 健康 | いいえ | |
| 金融 | いいえ | |
| 政府アプリ | いいえ | |
| プライバシーポリシー | 0-2 のURL | |

**機密性の高い権限の宣言フォーム**が要るのは、バックグラウンド位置情報・
SMS/通話履歴・全ファイルアクセス・インストール済みアプリ一覧の4系統。
**どれも使っていないので提出不要。**

ひとつだけ確認が要るのが**「写真と動画の権限」**の宣言。
`READ_MEDIA_IMAGES` を要求している場合に宣言が要る。
`image_picker` は Android 13+ では Photo Picker を使うので原則要求しないはずだが、
**2-8 の方法で最終マニフェストを確認してから**答える。

### 2-6. データセーフティ

1-7 と同じ内容を Google の分類で申告する。

| データ | 収集 | 共有 | 目的 | 必須か |
| --- | --- | --- | --- | --- |
| 写真 | する | する(LLMプロバイダ) | アプリの機能 | 必須 |
| 音声 | する | する(STT / LLM) | アプリの機能 | 必須 |
| ユーザーID(匿名UUID) | する | しない | アプリの機能 | 必須 |
| 購入履歴 | する | する(RevenueCat) | アプリの機能 | 必須 |
| クラッシュログ | する | する(Sentry) | 分析 | 任意にできる |
| その他(学習の記録) | する | しない | アプリの機能 | 必須 |

- **「共有」の判定に注意。** 写真や会話を LLM API に送っている場合、
  Googleの定義では「第三者への共有」に当たる。0-3 とあわせて事実を確認する。
- 「転送中の暗号化」= はい(HTTPS / WSS)
- 「削除リクエストの手段」= 0-3 の方針しだい。
  匿名IDのみで本人確認ができないので、**アプリ内に削除導線を置くのが現実的**
  (いまは未実装)。

### 2-7. 定期購入

**収益化 > 商品 > 定期購入**

1. 商品ID(例 `premium_monthly`)— **後から変更できない**
2. 基本プラン(期間・価格・自動更新)
3. 名前と説明
4. 無料トライアルを付けるなら「特典」から追加

商品IDは iOS と揃えなくてよい(RevenueCat が Entitlement `premium` に束ねる)。

### 2-8. Android の権限

リポジトリのマニフェスト(`android/app/src/main/AndroidManifest.xml`)で
**明示的に宣言しているもの**:

| 権限 | 何のため |
| --- | --- |
| `INTERNET` | backend / LiveKit との通信。**debug/profile用マニフェストにしか無く、releaseで落ちるので手で足した** |
| `RECORD_AUDIO` | 声で説明してもらう(LiveKit) |
| `MODIFY_AUDIO_SETTINGS` | スピーカー / イヤホンの切り替え |
| `CAMERA` | ノートの撮影 |

これに加えて、**依存ライブラリのマニフェストがマージされて入るもの**があります。
確認できたぶん:

| 権限 | 由来 |
| --- | --- |
| `ACCESS_NETWORK_STATE` | `connectivity_plus` |
| `WRITE_EXTERNAL_STORAGE`(`maxSdkVersion` 付き) | `camera_android_camerax` |

さらに、ネイティブSDK(AAR)側のマニフェストからも入ります。
`POST_NOTIFICATIONS` / `WAKE_LOCK`(OneSignal)、
`com.android.vending.BILLING`(Play Billing)などが該当しますが、
**これらはAARを解決しないと確定しないので、この環境では未確認です。**

申告の前に、必ずビルドして最終形を見てください:

```bash
cd apps/mobile
flutter build apk --debug
# マージ後のマニフェスト
cat build/app/intermediates/merged_manifests/debug/AndroidManifest.xml | grep uses-permission
```

Play Console にAABを上げたあとなら
**リリース > App Bundle エクスプローラ > 権限** でも一覧が見られます。
2-5 の「写真と動画の権限」の判断はこの一覧を見てから答えてください。

### 2-9. Google Play Developer API(Codemagic用)

`codemagic.yaml` の `publishing.google_play` が使う認証情報。

1. Google Cloud Console でプロジェクトを作る(既存でも可)
2. **サービスアカウント**を作り、JSON鍵をダウンロード
3. Play Console > **ユーザーとアクセス権** でそのサービスアカウントを招待
4. 権限は **「リリース」**(アプリ単位でよい。
   `リリースの作成・公開` と `テストトラックへの公開` があれば足りる)
5. JSON を丸ごと Codemagic の変数グループ `google-play` の
   `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` に **Secure で** 入れる

### 2-10. RevenueCat(Google側)

1. RevenueCat に Play Store のアプリを追加し、パッケージ名を入れる
2. **2-9 とは別のサービスアカウント**を用意して JSON を RevenueCat に渡す
   (権限は「財務データの閲覧」と「注文と定期購入の管理」)
3. **リアルタイム デベロッパー通知**: Play Console > 収益化 > 収益化のセットアップ で
   RevenueCat が発行する Pub/Sub トピックを設定
4. Products に 2-7 の商品IDを登録
5. **Entitlement は `premium`、Offering は `current`**(1-10 の 5・6 と同じ理由で必須)
   — Entitlement と Offering は**プロジェクト共通**なので、Apple側で作ってあれば作り直さない
6. 公開SDKキー(`goog_...`)を `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` へ

---

## 3. 詰まりやすい順序

リードタイムが長いものから着手する。

1. **Apple Developer Program / Play Console の登録**(法人は数週かかる)
2. **有料App契約(1-5)**(経理・銀行待ち)
3. **0-1 の年齢層の決定**(あとで変えるとSDKごと作り直し)
4. **プライバシーポリシーのURL(0-2)**
5. App ID とアプリレコードの作成(1-2 / 1-4 / 2-2)
6. 鍵まわり(1-3 / 2-9)→ ここまで来ると Codemagic が回る
7. 定期購入と RevenueCat(1-6 / 1-10 / 2-7 / 2-10)
8. 申告類(1-7 / 1-8 / 2-5 / 2-6)

6 までで TestFlight / 内部テストには配れます。
7・8 は公開の直前でも間に合いますが、7 が無いとペイウォールが動きません。
