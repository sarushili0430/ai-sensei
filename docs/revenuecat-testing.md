# 課金を実際に通す / テストする

「決済が最後まで通るか」を確かめる手順。ダッシュボードとアプリの噛み合わせは
[`revenuecat.md`](revenuecat.md)、ストアへの申請作業は
[`ci/store-setup.md`](ci/store-setup.md) にある。ここは**実際にお金の流れる経路を
どう踏むか**だけを書く。

---

## 0. どのルートで試すか

課金のテストには3つのルートがあり、**必要な準備と、確かめられる範囲が違う**。
上から順に重くなる。

| | 準備 | 何が確かめられるか | 支払い手段 |
| --- | --- | --- | --- |
| **A. Test Store** | RevenueCat だけ(5分) | Offering / ペイウォール / entitlement / webhook | **無し**(ダイアログで結果を選ぶ) |
| **B. iOS Sandbox** | App Store Connect の商品 + Sandbox Apple ID | A に加えて、ストアの購入UIと更新・失効 | **無し**(Appleは請求しない) |
| **C. Play ライセンステスト** | Play Console の商品 + テストトラックに配信 | A に加えて、Googleの購入UIと保留決済 | **テストカード**(下の §3) |

**「デモカードを使う」のは C だけ。** A は支払い画面自体が出ず、B の Apple は
サンドボックスで支払い方法を一切聞かない。カード番号を入れて試すのは Android のみ。

このリポジトリは A・B・C のどれでも動くようにしてある(鍵を差し替えるだけ)。
**最初は A で通し切ってから B・C に進むのが速い。** A で落ちるものは
B・C でも落ちるうえ、A のほうが原因が切り分けやすい。

> **共通の前提**: サーバ側の判定が正なので、どのルートでも
> 「アプリでPremiumになった」だけでは終わっていない。
> **webhook が届いて D1 が書き換わるところまで**見ること(§5)。

---

## 1. ルートA — Test Store(ストア設定ゼロ)

App Store Connect / Play Console に商品を作る前に、購入フローを最後まで通せる
RevenueCat側の疑似ストア。実際の請求は発生しない。

`purchases_flutter` は 9.8.0 以降が Test Store に対応していて、
このリポジトリは `^10.7.0` なのでそのまま使える。

### 1-1. ダッシュボード側

1. RevenueCat の **Apps & providers** を開く
2. **Test Store** を有効にする(プロジェクトごとに自動で用意されている)
3. 出てきた **`test_` で始まる公開SDKキー**を控える
4. **Product catalog** で商品・Offering・Entitlement を作る
   - Entitlement は `premium`、Offering は `current`、パッケージは
     `$rc_weekly` / `$rc_monthly` / `$rc_annual`
   - **これは Apple/Google のときと同じもの**を作る作業で、Test Store 専用の
     作り方があるわけではない。詳細は [`revenuecat.md`](revenuecat.md) §2

### 1-2. アプリ側

`apps/mobile/dart_defines.env` の `REVENUECAT_SDK_KEY` に `test_...` を入れる。
`REVENUECAT_IOS_PUBLIC_SDK_KEY` / `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` は
**空のままにする**(入っているとそちらが優先される)。

```bash
cd apps/mobile
fvm flutter run --dart-define-from-file=dart_defines.env
```

ペイウォールに「Test Store で動作しています」の注記が出ていれば、
Test Store の鍵で動いている(`AppStrings.testStoreNotice`)。

### 1-3. 購入する

プランを押すと、ストアの購入画面ではなく **RevenueCat のダイアログ**が出る。
ここで結果を選べる:

| 選ぶもの | アプリ側で確かめること |
| --- | --- |
| Successful Purchase | ペイウォールが閉じてホームへ戻る。Premiumの表示に変わる |
| Failed Purchase | 失敗の文言が出る。画面は閉じない |
| Cancel | **何も出ない**。引き止めない(`PurchaseCancelled`) |

**3つとも押すこと。** 成功だけ試して出すと、失敗とキャンセルの分岐
(`purchase_outcome.dart`)が一度も実行されないまま本番に出ることになる。

### 1-4. 更新と失効

Test Store の定期購入は加速して更新される(期間に応じて5分〜1時間)。
**5回更新すると自動で解約される**ので、放っておけば失効まで一通り見られる。

### 1-5. できないこと

- **レシート検証そのもの**(StoreKit / Play Billing を通らないため)
- ストアのUI(価格表示・購入確認・Face ID)の見た目
- アップグレード / ダウングレード / 返金

これらは B・C でしか見られない。逆に言うと、**アプリのコードの分岐は
ほぼ全部 A で確かめられる**。

### 1-6. 絶対にやらないこと

**`test_` の鍵のままストアに提出しない。** RevenueCat が明記しているとおり
審査で落ちる。このリポジトリでは2か所で見張っている:

- `codemagic.yaml` の dart-define 検査 —— `REVENUECAT_IOS_PUBLIC_SDK_KEY` に
  `test_` の鍵が入っていたらビルドを落とす。プラットフォーム鍵が空で
  Test Store に落ちる場合は「このビルドは審査に出せない」と警告を出す
- `purchases_repository.dart` —— release ビルドが Test Store の鍵で動いていたら
  起動時にログを残す

---

## 2. ルートB — iOS Sandbox(Appleの購入UIを通す)

### 2-1. 先に済んでいる必要があるもの

| | 参照 |
| --- | --- |
| **有料App契約が有効** | [`ci/store-setup.md`](ci/store-setup.md) 1-5。**未締結だと Sandbox でも買えない** |
| サブスクリプションが作ってある | 同 1-6。ステータスは「送信準備完了」でよい(審査通過は不要) |
| RevenueCat に In-App Purchase Key が入っている | 同 1-10。**これが無いとレシートを検証できない** |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` に `appl_` の鍵 | 同 1-10 の 8 |

### 2-2. Sandbox Apple ID を作る

**App Store Connect > ユーザーとアクセス > Sandbox > テスターアカウント**
から作る。普段使いの Apple ID は使わない。

> **一度でも本番の App Store でサインインしたサンドボックスアカウントは、
> 二度とサンドボックスで使えなくなる。** 作り直すことになるので、
> テスト専用と割り切って扱うこと。

### 2-3. 端末で使う

1. 実機で `flutter run --release` するか、TestFlight から入れる
2. **設定 > App Store > Sandbox アカウント** でサンドボックスのApple IDを入れる
   (初回は購入しようとしたときにも聞かれる)
3. アプリのペイウォールから購入する

**支払い方法は聞かれない。** サンドボックスの購入にカードは要らないし、
登録もできない。「デモカードはどこですか」となったらルートを間違えている。

> 本番のApple IDとサンドボックスのApple IDに同時にサインインしていると
> サンドボックスの購入が動かないことがある。うまくいかないときはここを疑う。

### 2-4. 更新が速い

サンドボックスでは期間が圧縮される。RevenueCat が公開している対応表:

| 実際の期間 | サンドボックス |
| --- | --- |
| 3日 | 2分 |
| 1週間 | 3分 |
| 1か月 | 5分 |
| 2か月 | 10分 |
| 3か月 | 15分 |
| 6か月 | 30分 |
| 1年 | 1時間 |

自動更新は**最大6回**で止まる。アプリを開いていなくても更新される。

> **TestFlight は別扱い。** 2024年12月に Apple が仕様を変え、TestFlight 配布の
> サブスクリプションは期間によらず **24時間に1回**しか更新されなくなった。
> 更新まわりを短時間で見たいなら、TestFlight ではなく開発ビルドで試すこと。

### 2-5. サンドボックス特有の詰まり

- **Appleが意図的に課金エラーを起こす**(更新時のみ。初回購入は必ず通る)。
  `BILLING_ISSUE` の webhook が来るので、剥奪の経路を見るには好都合
- **解約・返金の導線が無い**。Customer Center を開いても本番と同じには操作できない
- **アップグレード / クロスグレードは動かない**
- 加速のせいで、更新がダッシュボードに全部は出ないことがある
- 全般に不安定。1回落ちただけで実装を疑う前に、もう一度試すこと

### 2-6. シミュレータで試したい場合

Xcode の **StoreKit Configuration file** を使うと、App Store Connect も
サンドボックスアカウントも無しにシミュレータで購入できる。
ただしレシートがローカル生成になり、RevenueCat 側の見え方が本番と変わる。
**同じことは §1 の Test Store でより本番に近い形でできる**ので、
このリポジトリでは `.storekit` ファイルを置いていない。

実機のサンドボックスで試すときは、Xcode の Scheme の
**StoreKit Configuration を「None」にすること。** 設定したままだと
ローカルのレシートが使われ、サンドボックスに繋がらない。

---

## 3. ルートC — Play のライセンステスト(テストカードを使う)

**「デモカードで決済をテストする」はこれ。** Google だけが、実際に
支払い方法を選ぶ画面まで出したうえで、そこにテスト用のカードを出してくれる。

### 3-1. 先に済んでいる必要があるもの

| | 参照 |
| --- | --- |
| 定期購入が作ってある | [`ci/store-setup.md`](ci/store-setup.md) 2-7 |
| RevenueCat に サービスアカウントJSON が入っている | 同 2-10 |
| **アプリがテストトラックに上がっている** | 同 2-4。ローカルの `flutter run` では商品が取れない |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` に `goog_` の鍵 | 同 2-10 の 6 |

> **`flutter run` で入れたAPKでは課金が動かない。** Play Billing は
> 「Playから配信された、Playの署名が付いたアプリ」しか相手にしない。
> 内部テストトラックに上げて、テスターとして Play ストアから入れること。

### 3-2. ライセンステスターに登録する

**Play Console > (左下)設定 > ライセンステスト** に、テスターの
Googleアカウントを追加する。**内部テストのテスター登録とは別の設定**で、
両方に入っている必要がある。

- 登録しないまま買うと**本当に請求される**
- 反映に時間がかかる(数時間かかることがある)ので、先に済ませておく
- アプリを公開しているアカウント自身は、常にライセンステスター扱い

### 3-3. テストカードで買う

ライセンステスターとして購入画面を開くと、支払い方法の一覧に
テスト用の項目が出る:

| 支払い方法 | 何が起きるか | 何を見るか |
| --- | --- | --- |
| **テストカード、常に承認** | 即座に成功 | 正常系。**まずこれ** |
| **テストカード、常に拒否** | 即座に失敗 | 失敗の文言が出るか。画面を閉じないか |
| **低速テストカード、数分後に承認** | 保留(PENDING)→ 数分後に成功 | **`PurchaseOutcome.pending`** の経路 |
| **低速テストカード、数分後に拒否** | 保留 → 数分後に失敗 | 保留のまま解放していないか |

**低速テストカードは必ず試すこと。** コンビニ払いなどの「支払いが後から確定する」
経路がここにしかなく、`pending` を成功として扱っていると
**払っていない人にPremiumを渡す**ことになる。
アプリ側の分岐は `domain/purchase_outcome.dart` にある。

> テスターの定期購入も加速して更新される(実際の期間より大幅に短い)。

### 3-4. 本物のカードでしか見られないもの

3Dセキュア・カードの有効性確認・決済代行のタイムアウトは、テストカードでは
再現されない。公開後に実カードで1回買ってみて、すぐ返金するのが確実。

---

## 4. 実際にお金を受け取るために要るもの(最終チェック)

テストが通っても、**次のどれか1つが欠けていると本番で1円も入らない**。
リンク先が本体の手順で、ここは抜けを見つけるための一覧。

### Apple

- [ ] **有料App契約**が有効(銀行口座・税務情報まで完了)——
      [`ci/store-setup.md`](ci/store-setup.md) 1-5
- [ ] サブスクリプションが **「承認済み」**(サンドボックスは「送信準備完了」で
      買えてしまうので、ここで気づかないまま出しがち)
- [ ] RevenueCat に **In-App Purchase Key** —— 同 1-10 の 2
- [ ] **App Store Server Notifications V2** の URL が RevenueCat 向き —— 同 1-10 の 3
- [ ] ペイウォールの**審査用スクリーンショット**が商品に添付済み —— 同 1-6 の 3
- [ ] `REVENUECAT_IOS_PUBLIC_SDK_KEY` が `appl_`(`test_` ではない)

### Google

- [ ] RevenueCat に**サービスアカウントJSON**(Codemagic 用とは別のもの)——
      [`ci/store-setup.md`](ci/store-setup.md) 2-10 の 2
- [ ] **リアルタイム デベロッパー通知**に RevenueCat の Pub/Sub トピック —— 同 2-10 の 3
- [ ] 定期購入が有効化されている
- [ ] `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` が `goog_`

### RevenueCat・サーバ

- [ ] Products が Entitlement **`premium`** に紐づいている
      (紐づけ忘れると、決済は通るのに何も解放されない)
- [ ] Offering が **`current`** で、パッケージが入っている
- [ ] Webhook が `https://<api>/v1/webhooks/revenuecat` を向いていて、
      Authorization ヘッダが `REVENUECAT_WEBHOOK_AUTH` と一致
- [ ] **本番の webhook URL が本番のワーカーを向いている**(develop のままにしない)

---

## 5. webhook まで通っているかを見る

**アプリがPremiumになっただけでは終わっていない。** セッション上限などの
実効的な制限はサーバ側(`backend/api/src/lib/entitlement.ts`)が決めるので、
webhook が届いて D1 が書き換わるところまで確かめる。

### 5-1. 手元で叩く

RevenueCat を待たずに、ペイロードを直接投げて経路を確かめられる。

```bash
cd backend/api && pnpm dev    # http://localhost:8787

curl -sS -X POST http://localhost:8787/v1/webhooks/revenuecat \
  -H 'content-type: application/json' \
  -H "authorization: $REVENUECAT_WEBHOOK_AUTH" \
  -d '{"event":{"type":"INITIAL_PURCHASE","app_user_id":"<端末のdevice_id>",
       "environment":"SANDBOX","entitlement_ids":["premium"],
       "expiration_at_ms":4102444800000}}'
```

`{"ok":true}` が返ったら `GET /v1/me` を同じ `device_id` で叩き、
Premium になっていることを見る。

- **401** → `REVENUECAT_WEBHOOK_AUTH` が空か、値が違う
  (空のときは全部拒否する仕様)
- **400** → ペイロードの形が違う
- `{"ok":true,"ignored":"sandbox"}` → §5-3

### 5-2. RevenueCat から送る

ダッシュボードの Webhooks 設定に**テスト送信**のボタンがある。
届いた結果(ステータスコードとレスポンス)がダッシュボード側に残るので、
まずここを見る。実際の購入イベントの履歴も同じ場所で追える。

`app_user_id` はアプリが使っている匿名デバイスID(`ai_sensei.device_id`)。
**アプリ側のログか `GET /v1/me` で実物を確認してから**投げること。
架空のIDで投げると、そのIDのレコードだけが作られて何も変わらない。

### 5-3. 本番は sandbox の購入を無視する

RevenueCat は **sandbox の購入も本番と同じ URL に**送ってくる
(`environment` が `"SANDBOX"` になるだけ)。素通しにすると、テスターが
1人買うたびに本番のD1に有料の記録が残る。

そこで `ALLOW_SANDBOX_PURCHASES` で切り分けている
(`backend/api/src/env.ts` の `allowsSandboxPurchases`):

| 環境 | 既定 | 挙動 |
| --- | --- | --- |
| local / develop | `true` | sandbox の購入も本物と同じように反映する |
| production | `false` | 200 を返した上で**無視する**(ログには残る) |

**実機の課金テストは develop のワーカーに当てること。**
`API_BASE_URL` を develop に向けてビルドすればよい。

本番で一時的に通したいとき(リリース直前の疎通確認など)だけ、
`ALLOW_SANDBOX_PURCHASES=true` を明示的に立てる。
**確認が終わったら戻すこと。**

> 401 や 400 を返すと RevenueCat は成功するまで再送し続ける。
> だから「無視する」場合も 200 を返している。

---

## 6. 症状から原因を引く

| 症状 | 見るところ |
| --- | --- |
| ペイウォールに商品が1つも出ない | Offering が `current` か。パッケージの識別子が `$rc_weekly` などの定型か |
| 決済は通るのにPremiumにならない | Product が Entitlement `premium` に紐づいているか。`REVENUECAT_ENTITLEMENT_ID` がずれていないか。アプリは「購入は完了しましたが、まだ反映されていません」と出す |
| アプリはPremiumなのに、会話がすぐ切れる | webhook が届いていない(§5)。実効的な上限はサーバ側が持っている |
| Android で商品が取れない | Playから配信されたビルドか。ライセンステスターに入っているか。反映待ちでないか |
| iOS Sandbox で購入できない | 有料App契約が有効か。本番のApple IDと同時にサインインしていないか。Scheme の StoreKit Configuration が「None」か |
| テストで買ったのに本番に反映されない | §5-3。本番は sandbox を無視する。これは想定どおりの動き |
| 復元したのにサーバ側が無料のまま | `TRANSFER` の取りこぼし。[`revenuecat.md`](revenuecat.md) §5 |

---

## 7. 出典

RevenueCat の公式ドキュメント(`www.revenuecat.com/docs`)が一次情報。
このページの内容は以下から取っている。

- [Sandbox Testing](https://www.revenuecat.com/docs/test-and-launch/sandbox)
- [RevenueCat Test Store](https://www.revenuecat.com/docs/test-and-launch/sandbox/test-store)
- [Apple App Store & TestFlight](https://www.revenuecat.com/docs/test-and-launch/sandbox/apple-app-store)
- [Google Play Store](https://www.revenuecat.com/docs/test-and-launch/sandbox/google-play-store)
- [Webhooks / Event Types and Fields](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields)
- [App Store Service Credentials](https://www.revenuecat.com/docs/store-configuration/app-store/service-credentials-index)
- [RevenueCat/iOS-Subscription-Testing](https://github.com/RevenueCat/iOS-Subscription-Testing/blob/master/basics/sandbox.md)(更新の加速表)
- [Test your Google Play Billing Library integration](https://developer.android.com/google/play/billing/test)(テストカードの一覧)
- [アプリ ライセンスを使用したアプリ内課金のテスト](https://support.google.com/googleplay/android-developer/answer/6062777?hl=ja)
