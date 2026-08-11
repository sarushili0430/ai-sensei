# RevenueCat

課金は RevenueCat SDK(`purchases_flutter` + `purchases_ui_flutter`)で通す。
Shipaton の参加条件(SDKで最低1つのアプリ内課金)を満たす箇所でもある。

ストア側の申請作業は [`docs/ci/store-setup.md`](ci/store-setup.md) にある。
ここは **アプリとダッシュボードの噛み合わせ** だけを書く。

---

## 1. どこで何をしているか

| ファイル | 役割 |
| --- | --- |
| `data/revenuecat_config.dart` | `--dart-define` から鍵・entitlement・offering を読む |
| `data/purchases_repository.dart` | SDKの唯一の出入口。テストではここごと差し替える |
| `domain/entitlement.dart` | `CustomerInfo` / `Offering` を画面が使う形に落とす純関数 |
| `domain/purchase_outcome.dart` | SDKの例外を「キャンセル / 失敗の種類」に畳む純関数 |
| `application/entitlement_controller.dart` | 状態を持つ。購入・復元・ペイウォール・Customer Center の入口 |
| `application/premium_sync.dart` | entitlement が変わったら、サーバ側の判定を読み直す(§9) |
| `presentation/paywall_screen.dart` | RevenueCatのペイウォール →(出せなければ)自前のペイウォール |
| `presentation/thanks_screen.dart` | 購入・トライアル・復元のお礼。ペイウォールの次に出る |
| `presentation/manage_subscription_button.dart` | Customer Center の導線・契約カード・Premium の印 |
| `main.dart` | 起動時に一度だけ `configure` する |

## 買えたあとに出るもの

購入が通ったら**必ず `/thanks` へ寄せる**。入口が3つあるので、
どれか1つでも `closeOrGoHome()` のままだと、その経路で買った人にだけ
何も出なくなる:

| 入口 | 呼ぶもの |
| --- | --- |
| 自前ペイウォールの `PurchaseSucceeded()` | `context.replaceWithThanks()` |
| RevenueCat ペイウォールの `PaywallResult.purchased` | `context.replaceWithThanks()` |
| 復元(ペイウォール / 設定) | `context.replaceWithThanks(restored: true)` / `pushThanks(restored: true)` |

見出しは3通りに分かれる。**「ご購入ありがとうございます」と書けない場合が
あるため**(§6 誠実さ):

- **無料トライアル**(`Entitlement.isTrial`)— まだ1円も払っていない。
  日数と、課金が始まる日を先に言う。`PeriodType.intro`(初月100円のような
  **有料の**キャンペーン)は無料に数えないこと。
- **復元** — 買い直していない。お礼を言うと二重に払ったのかと思わせる。
- **決済は通ったが entitlement が付いていない** — ルータの `redirect` が
  ホームへ弾く。祝ってから使えないのが、いちばん落差が大きい。

契約している印は2か所。ホーム右上の `PremiumChip` と、設定の
`SubscriptionStatusCard`(状態と、更新日 / 終了日 / 課金開始日)。
**ランクや称号にしないこと** — 数えるのは連続日数と埋めた穴だけ(§7)。

`Purchases.configure` は **`main()` で一度だけ**呼ぶ。
provider の `build()` の中で呼ぶと、providerが再構築されるたびに走ってしまう。

```dart
// main.dart
await const PurchasesRepository().configure(appUserId: deviceId);
```

`appUserID` には匿名デバイスID(`ai_sensei.device_id`)をそのまま渡す。
アカウント作成を要求しないので `logIn` は使わない。この値が webhook の
`app_user_id` に乗ってきて、`backend/api/src/routes/webhooks.ts` が D1 に同期する。

**サーバ側の判定が正**。アプリ側の entitlement はUIの出し分けにだけ使い、
セッション上限などの実効的な制限は `backend/api/src/lib/entitlement.ts` が決める。

---

## 2. ダッシュボードで作るもの

### Products

ストアに作った商品IDをそのまま登録する。

| 期間 | RevenueCatのパッケージ識別子 |
| --- | --- |
| 週 | `$rc_weekly` |
| 月 | `$rc_monthly` |
| 年 | `$rc_annual` |

アプリ側は `PackageType`(weekly / monthly / annual)で読むので、商品IDは
iOSとAndroidで揃っていなくてよい。上の定型識別子を使っておけば
`plansOf()` が拾う。定型以外の識別子で作ったパッケージは**画面に出ない**。

### Entitlement

identifier は **`premium`**。表示名は何でもよい。

ここがずれると「課金は成立するのに何も解放されない」という、
もっとも気づきにくい壊れ方をする。別名にしたい場合はアプリ側も合わせること:

```bash
flutter run --dart-define=REVENUECAT_ENTITLEMENT_ID=pro
```

作った Product は忘れずに Entitlement に紐づける。紐づけ忘れると購入は
通るのに entitlement が付かない。アプリはこれを検知して
「購入は完了しましたが、まだ反映されていません」と出す(成功として画面を閉じない)。

### Offering

`current` に設定し、上の3パッケージを入れる。current が空だと
ペイウォールに何も出ない。

### Paywall

Offering に紐づけて作る([Paywalls](https://www.revenuecat.com/docs/tools/paywalls))。
文言・価格・画像をダッシュボードから差し替えられるので、
アプリを出し直さずにペイウォールを直せる。

**作らなくても動く。** 未設定なら `PaywallResult.error` が返り、
アプリは自前のペイウォール(`paywall_screen.dart` の `_ManualPaywall`)に落ちる。
自前のほうを残してあるのは、鍵の無いビルド・古いOS・ダッシュボード未設定の
どれでも「無料継続の導線がある画面」が必ず出るようにするため。

> ダッシュボードでペイウォールを作るときも §6 の約束は守ること:
> 「無料のまま続ける」を隠さない・解約できると明記する・カウントダウンを使わない。
> HAMM賞は誠実さを見る。

### Customer Center

[Customer Center](https://www.revenuecat.com/docs/tools/customer-center) を有効にする。
解約・プラン変更・返金申請・購入の復元がひとまとめになっていて、
自前で作ると App Review のたびに指摘が出る類の画面。

アプリでは **契約がある人にだけ**ホームに導線を出す(`ManageSubscriptionButton`)。
契約が無い人向けの「購入を復元する」はペイウォールにある。

---

## 3. 鍵を渡す

値は `apps/mobile/dart_defines.env`(gitignore済み)にまとめる。
テンプレートは `dart_defines.example.env`。

```bash
cp dart_defines.example.env dart_defines.env
fvm flutter run --dart-define-from-file=dart_defines.env
```

| 変数 | 中身 |
| --- | --- |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | `appl_...`。本番のiOS |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | `goog_...`。本番のAndroid |
| `REVENUECAT_SDK_KEY` | `test_...`。Test Store。**上の2つが空のときだけ**使われる |
| `REVENUECAT_ENTITLEMENT_ID` | 既定 `premium` |
| `REVENUECAT_OFFERING_ID` | 空なら current |

公開SDKキーは**ビルド成果物に埋め込まれる前提の値**なので秘匿不要。
シークレットキー(`sk_...`)と webhook の共有シークレットは backend 側にあり、
`pnpm run verify:secrets` が混入を見張っている。

**鍵を渡さないビルドでは課金機能ごと黙って無効になる**(`RevenueCatConfig.isConfigured`)。
`flutter test` と CI はこの経路を通るので、課金と関係ない画面のテストが
巻き添えで落ちることはない。

### Test Store

`test_` で始まる鍵を使うと、App Store Connect / Play Console に商品を作る前でも
購入フローを最後まで通せる。実際の請求は発生しない。
ペイウォールにその旨の注記が出る(`AppStrings.testStoreNotice`)。

ストア側の商品ができたら `REVENUECAT_IOS_PUBLIC_SDK_KEY` /
`REVENUECAT_ANDROID_PUBLIC_SDK_KEY` を入れる。そちらが優先されるので
`REVENUECAT_SDK_KEY` は消さなくてよい。

---

## 4. プラットフォームの要件

| | 要件 | 理由 |
| --- | --- | --- |
| iOS | 15.0 以上 | Paywalls / Customer Center が iOS 15+。`project.pbxproj` の `IPHONEOS_DEPLOYMENT_TARGET` を 15.0 にしてある |
| Android | minSdk 24 以上 | `purchases_ui_flutter` の要件。Flutter の既定が 24 なので追加設定は不要 |

---

## 5. 復元と、サーバ側の付け替え(TRANSFER)

匿名デバイスIDはアンインストールで消え、機種変更でも変わる。
つまり**復元するときの app_user_id は、買ったときのものと違う**。

ダッシュボードの **Restore Behavior** をどちらにしているかで挙動が分かれる。

| 設定 | 起きること |
| --- | --- |
| Transfer to new App User ID | RevenueCat が購入を付け替え、`TRANSFER` webhook を送る |
| Keep with original App User ID | 付け替わらない。アプリは「復元できる購入は見つかりませんでした」と出す |

前者のとき、`TRANSFER` を取りこぼすと**アプリは「復元しました」と言うのに
サーバ側は無料のまま**になる(復習も履歴も開かない)。
サーバ側の判定が正なので、食い違うと利用者からは「直らない不具合」に見える。

`backend/api/src/routes/webhooks.ts` がこれを処理する。TRANSFER だけ形が違う:

- `app_user_id` が**無い**。代わりに `transferred_from` / `transferred_to`(配列)
- `expiration_at_ms` も `entitlement_ids` も**無い**(商品単位ではなく全部の付け替えなので)

期限が payload に無いので、**移行元のレコードから引き継ぐ**。
移行元にPremiumの記録が無ければ付けない — 期限なしで付けると、
復元するだけで無期限Premiumが作れてしまうため。その場合は次の
`RENEWAL` / `EXPIRATION` が新しいIDで届いて正しい期限に揃う。

---

## 6. 状態はSDKから push される

`Purchases.addCustomerInfoUpdateListener` を
`PurchasesRepository.customerInfoChanges()` でStreamに包み、
`EntitlementController` が購読している。

更新・失効・ペイウォール内での購入・Customer Center での解約が、
画面を開き直さなくても反映される。ポーリングは無い。

ただしこれは**アプリ側の entitlement が変わるだけ**で、サーバ側の判定は
別経路(webhook)で遅れて変わる。噛み合わせは §9。

---

## 7. 失敗の扱い

SDKは失敗を `PlatformException` で投げる。**利用者が自分で閉じた場合も例外**なので、
そのまま画面に流すと「やめただけ」の人にエラーを見せることになる。

`PurchaseOutcome.fromException` が キャンセル / 失敗の種類 に畳んでから返す。

| 分類 | 例 | 画面に出すこと |
| --- | --- | --- |
| キャンセル | 利用者が閉じた | **何も出さない**。引き止めない |
| `network` | 圏外・タイムアウト | 時間をおけば直ると伝える |
| `storeProblem` | ストア障害 | こちらでは直せないと伝える |
| `alreadyOwned` | すでに契約がある | 「購入を復元する」へ誘導 |
| `pending` | コンビニ払いなど | 承認されたら自動で使えると伝える |
| `configuration` | 商品ID・Entitlementの取り違え | **実装ミス**。ログに詳細を出す |

`configuration` が出たらダッシュボードとの噛み合わせを疑うこと。
`EntitlementController._warnIfMisconfigured` が、entitlement identifier の
ずれと空の Offering を release ビルドでもログに残す。

---

## 8. テスト

```bash
cd apps/mobile
fvm flutter test test/monetization_test.dart test/premium_sync_test.dart
```

見ているのは「SDKが動くか」ではなく **SDKの返した値をこちらが取り違えていないか**。
entitlement identifier のずれ・パッケージの並び・0円ではない導入価格を
「無料」と書かないこと・キャンセルを失敗にしないこと、を押さえている。

ペイウォールの golden(`test/golden/goldens/paywall.png`)は鍵の無いビルド、
つまり自前のペイウォールを撮っている。「無料のまま続ける」と
「いつでも解約できます」が消えていないかは `test/widget_test.dart` が見る。

---

## 9. アプリの entitlement と、サーバの `is_premium`

Premium は**2つの経路で別々に**更新される。ここがこのアプリで
いちばん噛み合わせを間違えやすい。

| | 誰が書くか | いつ |
| --- | --- | --- |
| アプリの entitlement | SDK(`CustomerInfo`) | 購入した瞬間 |
| サーバの `users.is_premium` | RevenueCat の webhook | 数秒遅れ |

そして**画面が出し分けに使っているのはサーバ側**のほう。ホームと
復習画面の授業可否(`/v1/me/progress` の `is_premium` /
`limits.lesson_allowed_today`)、セッション開始の可否
(`free_limit_reached` / `fair_use_limit_reached`)。
判定を持たせないのは、クライアントの申告で上限を緩められないようにするため(§handoff 5)。

それを読む `ProgressController` は `keepAlive` で、
**起動時に一度読んだきり**誰も読み直さない。だから購入したあとに読み直す配線が要る。

`premium_sync.dart` がそれをやる。`EntitlementController` の変化を購読して、
Premium が付いた/外れたら `/v1/me/progress` を読み直す。webhook はまだ届いて
いないことがあるので、追いつくまで数回(1s / 2s / 4s / 8s)読み直す。

追いつかなければ**そこで諦めて無料のまま**にする。クライアントの言い分で
解放はしない。webhook が恒久的に壊れているならサーバ側で直すべきもので、
ここで上書きすると誰も壊れていることに気づけなくなる。

> これが無いと **webhook が200で届いていてもアプリは無料のまま**になる。
> 「課金は成立していて、ダッシュボードにもD1にも記録があるのに、
> アプリを再起動するまで何も解放されない」という壊れ方をする。
> `test/premium_sync_test.dart` がこの経路を押さえている。

購入の入口(自前のペイウォール・RevenueCat のペイウォール・Customer Center・
設定画面の復元)ごとに呼ぶのではなく、**entitlement の変化**で拾っているのは、
入口を足したときに呼び忘れても壊れないようにするため。
