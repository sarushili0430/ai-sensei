# 審査に添付する画像

ストア掲載用のスクショ(`../screenshots/`)とは用途が別。こちらは
**審査担当と、購入を迷っている人にだけ見える画像**で、売り文句は載せない。

| ファイル | 入れる場所 | サイズ |
| --- | --- | --- |
| `ja/paywall.png` `en/paywall.png` | App Store Connect > サブスクリプション > 各商品 > 審査に関する情報 > スクリーンショット | 1179x2556 |
| `subscription-promo-1024.png` | 同 > 画像(任意) | 1024x1024 |

`paywall.png` は**3商品それぞれに**添付する(1枚を使い回してよい)。
プロモーション画像も週/月/年で同じ Premium なので1枚を使い回す。

## 作り直し方

**絵の正はコード。** 画像を直接描き直さないこと。

```bash
cd apps/mobile

# ペイウォール。TERMS_URL / PRIVACY_POLICY_URL が要る(下記)
fvm flutter test tool/generate_paywall_review_screenshot.dart \
  --dart-define-from-file=dart_defines.env

# プロモーション画像
fvm flutter test tool/generate_subscription_promo_image.dart
```

### 価格を変えたら撮り直す

ペイウォールはストアが返した価格文字列をそのまま出す作りなので、
生成ツールの中に**実際に登録する3プランと同じ値**を置いてある
(`tool/generate_paywall_review_screenshot.dart` の `_offering`)。
ストア側の価格を変えたらこちらも直して撮り直すこと。

### 規約・プライバシーのリンクが要る

`TERMS_URL` / `PRIVACY_POLICY_URL` が空だとペイウォールから
リンクが**まるごと消える**(`external_link.dart` の `links.isEmpty`)。
Guideline 3.1.2 の必須要素なので、写っていないスクショは使えない。
渡し忘れは生成ツールが `setUpAll` で落とす。

### ダッシュボードにペイウォールを作った場合

いまの `paywall.png` は**自前のペイウォール**(`_ManualPaywall`)を撮っている。
RevenueCat のダッシュボードでペイウォールを作ると、実機ではそちらが
前面に出る([`docs/revenuecat.md`](../../revenuecat.md) §2)。その場合は
実機のスクショに差し替えること — 審査用スクショは実際に出る画面である必要がある。
