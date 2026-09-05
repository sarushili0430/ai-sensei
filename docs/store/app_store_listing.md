# App Store Connect — 掲載情報とApp内課金(コピペ用・日英)

App Store Connect の各フィールドに**そのまま貼るための本文**。正はここ。
[`../design_direction_v0.html#store`](../design_direction_v0.html) の同じ節は ADR 0009 より前の文面
(教え返し・カルテ)なので、コピペ元にしないこと(経緯を読む場所として残してある)。
Google Play 側は [`play_listing.md`](play_listing.md)。

- 製品の言い方は ADR 0009 の一本道: **撮る → 板書つきで教わる → 「わかった」→ その板書から復習問題1問 → 3日後・7日後に通知 → テキストで答えてAIが採点**。
  「教え返し」「カルテ」「言えた / まだ言えない」「答えを教えない」「正答率」「偏差値」は**書かない**。
- 価格は [`../business/pricing_v1.md`](../business/pricing_v1.md) で確定した 週 ¥980 / 月 ¥2,980 / 年 ¥29,800(米国 $6.99 / $19.99 / $199.99)。
  **説明文にも数字を書いてある**ので、価格を変えたらここも直す(アプリ側は Offering から引くので触らない)。
- 文字数は各フィールドの上限に収めてある(名前30・サブタイトル30・プロモ170・説明4000・キーワード100・IAP表示名30・IAP説明45)。
  変えたら数え直すこと。

---

## 1. 基本情報(App 情報 / 価格と販売状況)

| フィールド | 日本語 | English(en-US) |
| --- | --- | --- |
| 名前(30) | `カタルテ` | `カタルテ`(端末の表示名と揃える。英語圏向けに `Katarute` にするなら `InfoPlist.strings` も足す — `play_listing.md`「アプリ名の注意」) |
| サブタイトル(30) | `板書つきで教わって、3日後にもう一度` | `Taught on a board, asked again` |
| プライマリカテゴリ | 教育 | Education |
| セカンダリカテゴリ | 参考書 | Reference |
| 価格 | 無料(App内課金あり) | Free (In-App Purchases) |
| 年齢制限 | 4+ で申告(対話AIを理由に押し戻されたら 12+) | 同左 |
| 著作権 | `2026 〔権利者名〕` — **未決** | 同左 |
| 配信地域 | 全地域(米国を含める。Shipaton の参加要件)。**IAP は日本と米国だけ**になっているので、揃えるなら IAP 側も全地域に | 同左 |
| サポートURL | `https://ubiqy.jp/support/` | `https://ubiqy.jp/en/support/` |
| マーケティングURL | `https://ubiqy.jp/` | `https://ubiqy.jp/en/` |
| プライバシーポリシーURL | `https://ubiqy.jp/privacy/` | `https://ubiqy.jp/en/privacy/` |
| 利用規約(EULA) | 標準EULAでもよいが、自前を使うなら `https://ubiqy.jp/terms/` | `https://ubiqy.jp/en/terms/` |
| 輸出コンプライアンス | 済(`ITSAppUsesNonExemptEncryption = false`) | 同左 |

---

## 2. プロモーションテキスト(170字・審査なしで差し替えられる)

### JA
```
わからない問題を1枚撮ると、先輩AIが板書つきで教えてくれます。「わかった」を押すと、その板書から復習問題が1問。3日後と7日後に通知で届き、テキストで答えると先輩が見て、まちがえた問題は翌日もう一度たずねます。
```

### EN
```
Photograph a problem. Your senpai teaches it on a board. Tap "Got it" and a review question from that board returns in 3 and 7 days; wrong ones come back tomorrow.
```

---

## 3. 説明(4000字)

### JA
```
板書つきで教わって、3日後にもう一度。

わからない問題を撮ると、先輩AIが板書つきで教えてくれます。数式・計算・図は板書に書き、声は「ここ、Dを見てほしいんだけど — プラスだよね。だから?」と問いかけるだけ。授業を終わらせるのは、画面下の「わかった」を押すあなたです。

■「わかった」の3日後に、復習問題が1問届きます
「わかった」を押すと、その板書から復習問題が1問つくられ、3日後と7日後に通知で届きます。テキストで答えると先輩が「正解・不正解・読み取れなかった」の3つに分けて、まちがえた問題は翌日からもう一度たずねます。解答を読んで「わかった」と感じた状態と、3日後に自分で解ける状態は別物 — それを確かめるための1問です。

■ やることは、3つ
1. わからない問題を撮る。ノートもあれば一緒に撮ってください（どこまで書けたのかを先輩が見ます）。手も付けられなかった問題なら、問題だけで大丈夫です
2. 先輩が板書つきで教えます。わからないところは声で聞き返せます。「うまく言えない」は、いつでも押せます
3. 「わかった」を押す。3日後に、その板書からの復習問題が届きます

数式を音声で読み上げません（「エックスのにじょうマイナス3エックス…」は聞いても頭に入らないため）。書いている間は喋らない、というのは本物の家庭教師と同じやり方です。

■ 点数を出しません
数えるのは、続けた日数と、解けた問題の数だけ。正答率も偏差値も出しません。ランキングも、他人と比べる画面もありません。まちがえた問題は責めずに、翌日からもう一度たずねるだけです。

■ 4つの約束
1. 教える。降りるのは生徒。先輩は節目ごとに問いかけますが、授業を終わらせるのは「わかった」を押すあなたです
2. 点数を出さない。数えるのは、続けた日数と、解けた問題の数だけ
3. まちがいを恥にしない。不正解でも責める文面は書かず、通知の間隔が変わるだけです
4. 煽らない。通知も有料プランの案内も、命令や催促にはしません

■ 背景にある考え方
忘れかけた頃にもう一度思い出すほど記憶に残る、という間隔反復を「先輩からのおさらい」の形にしました。急かす通知は送りません。

■ 対応範囲
・科目: 中学数学（中1・中2・中3）／高校数学（数I・A・II・B・III・C）／中学英語（文法事項・文構造）／高校英語（英語コミュニケーションI・II、論理表現I）
・中学生か高校生かを設定で選ぶと、その段階の単元だけが候補に出ます
・言語: 日本語 / English。海外の学習者には海外の課程（Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics）で単元を出します
・必要なもの: カメラ（問題とノートの撮影）とマイク（先輩との会話）。許可を求めるのは、使う直前だけです
・アカウント作成は不要です。サインインもメールアドレスの登録もなく、匿名の端末IDだけではじめられます

■ 料金
無料 — 1日1回・10分、先輩に教わる／その板書からの復習問題（3日後・7日後）
Premium — 1回20分・毎日何問も／復習問題の履歴／穴を先輩に声で聞き直す／先輩との学習計画

■ 写真と音声の扱い
ノートの写真と、会話の文字起こしを、授業と復習問題を作るために保存します。匿名の端末IDにひもづき、氏名やメールアドレスは取得しません。広告は出しませんし、他社サービスをまたぐ追跡もしません。説明の分かりにくさや誤りを見つけてサービスを改善するためにも使い、停止や削除はサポート窓口から求められます。

■ 先輩が間違えることもあります
ありえます。板書は残るので、「わかった」を押す前に教科書と見比べられます。気になった説明・板書・問題は、アプリの設定から報告できます。

■ サブスクリプションについて
・名称: カタルテ Premium
・期間と価格: 1週間 ¥980 ／ 1か月 ¥2,980 ／ 1年 ¥29,800（いずれも自動更新）
・お支払いは、購入確定時に Apple ID アカウントに請求されます。
・期間終了の24時間以上前に自動更新をオフにしない限り、自動的に更新されます。
・購読の管理と自動更新の解除は、購入後に端末の「設定」＞「Apple ID」＞「サブスクリプション」から行えます。
・利用規約: https://ubiqy.jp/terms/
・プライバシーポリシー: https://ubiqy.jp/privacy/
```

### EN
```
Taught on a board. Asked again in 3 days.

Photograph a problem you're stuck on and a senpai — an older student — teaches it, writing on a board as they go. Equations, calculations and figures are written, not spoken; the voice only asks: "Look at D here. It's positive, right? So?" The lesson ends when you tap "Got it" — never before.

■ Three days later, one review question
When you tap "Got it", one review question is made from that board and sent to you as a notification 3 days and 7 days later. You answer in text; your senpai marks it correct, incorrect, or couldn't-read, and anything you got wrong comes back the next day. Feeling that you understood a worked solution and being able to solve it yourself three days later are two different things — the question exists to tell them apart.

■ Three steps
1. Photograph the problem, with your notes if you have them, so your senpai can see how far you got. Stuck from the start? The problem alone is fine
2. Your senpai teaches it on the board. Ask back whenever something is unclear; "I can't explain this yet" is always one tap away
3. Tap "Got it". In 3 days, a review question from that board arrives

Equations are never read aloud: a spoken formula does not stay in your head. Staying quiet while writing is how a real tutor works.

■ No scores
We count days in a row and problems solved — nothing else. No accuracy rate, no ranking, no screen that compares you with anyone. A wrong answer is never held against you; the question simply comes back tomorrow.

■ Four promises
1. We teach; you decide when you're done. Your senpai checks in along the way, but only "Got it" ends the lesson
2. No scores. Days in a row and problems solved, nothing else
3. Mistakes are never shameful. A wrong answer only changes when the question returns
4. No pressure. Notifications and upgrade prompts are never commands or nagging

■ Behind it
Spaced repetition — remembering something just as you start to forget it — written as a check-back from your senpai rather than a nag.

■ Scope
- Subjects: high school mathematics (Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics). In Japanese, junior-high and high-school mathematics and English on the Japanese curriculum
- Languages: English and Japanese
- What you need: a camera (the problem and your notes) and a microphone (talking with your senpai), requested only right before use
- No account, no sign-in, no email address — just an anonymous device ID

■ Pricing
Free — one 10-minute lesson a day from your senpai, plus the review questions made from it (3 and 7 days later)
Premium — 20 minutes a lesson, several a day, your review history, calling your senpai back by voice on a gap, and a study plan with your senpai

■ Photos and audio
Photos of your notes and transcripts of your conversations are stored to run the lesson and build your review questions. They are tied to an anonymous device ID; we never collect your name or email. No ads, no cross-service tracking. They are also used to find unclear or wrong explanations and improve the service; you can ask us to stop or delete through the support page.

■ Your senpai can be wrong
It can. The board stays on screen, so compare it with your textbook before you tap "Got it". Anything that felt wrong can be reported from Settings.

■ About the subscription
- Title: Katarute Premium
- Length and price: 1 week $6.99 / 1 month $19.99 / 1 year $199.99 (auto-renewing)
- Payment is charged to your Apple ID account at confirmation of purchase.
- The subscription renews automatically unless auto-renew is turned off at least 24 hours before the end of the current period.
- Manage or cancel in Settings > Apple ID > Subscriptions.
- Terms of Use: https://ubiqy.jp/en/terms/
- Privacy Policy: https://ubiqy.jp/en/privacy/
```

---

## 4. キーワード(100字・カンマ区切り)

### JA
```
数学,中学数学,高校数学,英語,中学英語,高校英語,勉強,学習,板書,復習,間隔反復,定期テスト,受験,苦手克服,自習,ノート,家庭教師,共通テスト,独学,AI
```

### EN
```
math,algebra,geometry,calculus,study,review,spaced repetition,exam,tutor,AI,homework,self study
```

---

## 5. このバージョンの新機能

### JA
```
はじめてのリリースです。
```

### EN
```
First release.
```

---

## 6. スクリーンショット

| 枠 | ファイル | 備考 |
| --- | --- | --- |
| iPhone 6.9インチ(必須) | `screenshots/{ja,en}/captioned/01..05.png`(1290×2796) | 日本語ロケールに `ja/`、英語に `en/` |
| iPhone 6.5インチ(任意) | `screenshots/{ja,en}/captioned-65/01..05.png`(1284×2778) | **6.5インチのタブに 1290×2796 を落とすと寸法エラー**("1242 × 2688px ... 1284 × 2778px")になる。タブごとに対応する枚を使う |
| iPad 13インチ(必須。アプリが iPad に入るため) | `screenshots/{ja,en}/ipad-13/01..05.png`(2064×2752) | 同上 |
| App プレビュー(動画) | 無し | 任意 |

並びは ①授業(板書)②祝福 ③復習問題 ④連続日数と解けた問題 ⑤復習。生成は
`cd apps/mobile && fvm flutter test tool/generate_store_screenshots.dart`(画像を直接描き直さない)。

---

## 7. App内課金(自動更新サブスクリプション)

サブスクリプショングループ: 日本語 `カタルテ Premium` / English `Katarute Premium`
(いまは `かたるて Premium`。API では名前を変えられなかったので、App Store Connect で手で直す)。

**2026-09-05 の反映状況**: 価格(日本・米国)と各商品の審査メモは RevenueCat 経由で App Store Connect に
入っている。**表示名・説明(ja の差し替えと en-US の追加)は Apple が API 経由の変更を拒否した**
(「NAME / LOCALE_CODE は変更不可」)ので、下の表の値を App Store Connect の画面から入れる。
旧説明「セッション無制限と穴の復習。…」は嘘になるので、審査に出す前に必ず差し替えること。

| | 週 | 月 | 年 |
| --- | --- | --- | --- |
| 参照名 | 週間プラン | 月間プラン | 年間プラン |
| 商品ID | `jp.co.aisensei.premium.weekly` | `jp.co.aisensei.premium.monthly` | `jp.co.aisensei.premium.yearly` |
| 期間 | 1週間 | 1か月 | 1年 |
| 価格(日本) | ¥980 | ¥2,980 | ¥29,800 |
| 価格(米国) | $6.99 | $19.99 | $199.99 |
| 無料トライアル | なし | なし | なし |
| 表示名 ja(30) | `カタルテ Premium 週額` | `カタルテ Premium 月額` | `カタルテ Premium 年額` |
| 説明 ja(45) | `毎日つづけて何問も教わる。1週間ごとの自動更新。` | `毎日つづけて何問も教わる。1か月ごとの自動更新。` | `毎日つづけて何問も教わる。1年ごとの自動更新。月あたり最も割安。` |
| 表示名 en-US(30) | `Katarute Premium Weekly` | `Katarute Premium Monthly` | `Katarute Premium Yearly` |
| 説明 en-US(45) | `Several lessons a day. Renews every week.` | `Several lessons a day. Renews every month.` | `Several lessons a day. Renews every year.` |
| 審査用スクリーンショット | `docs/store/iap-review/paywall-ja.png`(3商品とも同じ1枚) | 同左 | 同左 |

審査用スクリーンショットは現行UIのペイウォールを確定価格で描いたもの
(`cd apps/mobile && fvm flutter test --dart-define=TERMS_URL=https://ubiqy.jp/terms/ --dart-define=PRIVACY_POLICY_URL=https://ubiqy.jp/privacy/ tool/generate_iap_review_screenshot.dart`
で再生成。英語版は `paywall-en.png`)。App Store Connect に入っているのは 8月の古い1枚で、
**API では差し替えられなかった**(既存の1枚がある商品には新しい枠を取れない)ので、
各商品の「審査に関する情報」で古い画像を消してからこのファイルを上げる。

**「セッション無制限」とは書かない。** `PREMIUM_SECONDS_PER_DAY` のフェアユース上限があるので嘘になる
(`strings.dart` の `paywallEverydayQuestions` と同じ判断)。旧説明文にはこれが入っていた。

### 7-1. 各商品の審査メモ(App Store Connect > 商品 > 審査に関する情報 > メモ)

日本語と英語を1つの欄に続けて入れる(欄は1つしか無い)。

#### 週間プラン(`jp.co.aisensei.premium.weekly`)

```
■ 商品
カタルテ Premium（週額・自動更新）。¥980 / 1週間（米国 $6.99）。
週・月・年の3プランは同一サブスクリプショングループにあり、解放される機能はすべて同じです（期間と価格のみが異なります）。

■ 解放される機能
無料版は1日1回・最長10分の授業（先輩AIの板書つき解説）と、そこから作られる復習問題。Premium で、1回最長20分の授業を1日に続けて何問も教わる（フェアユース上限あり）、復習問題の履歴、穴を先輩に声で聞き直す授業、先輩との学習計画が使えます。

■ ペイウォールへの到達手順（写真撮影は不要です）
1. アプリを起動（サインイン・アカウント作成はありません。匿名の端末IDのみ）
2. 下部タブの「設定」を開き「契約 ＞ Premium にする」をタップ → ペイウォールが開きます（ほかに、下部タブ「計画」→「先輩と計画をつくる」、ホーム下部の「もっと教わる」、無料の1回を使い終えた直後の画面、復習画面の「先輩に聞く」からも開きます）
3. 週・月・年の3プランが並びます。「1週間」を選んで「このプランではじめる」

■ 表示していること
自動更新であること、いつでも解約できること、利用規約とプライバシーポリシーへのリンクをペイウォール上に常時表示しています。「無料のまま続ける」で購入せずに離脱できます。カウントダウン等の煽りはありません。価格はストアが返した文字列をそのまま表示しています。

■ 復元・解約
復元: ペイウォールの「購入を復元する」
解約/プラン変更/返金申請: 契約者のみホームに出る「サブスクリプションの管理」

■ 動作確認
Sandbox アカウントでそのまま購入できます。アカウント登録は不要です。無料版の1日の持ち時間は日付が変わると戻ります。

--- English ---
Katarute Premium (weekly, auto-renewing): JPY 980 / USD 6.99 per week. The weekly, monthly and yearly plans are in one subscription group and unlock identical features; only the period and price differ.
Free tier: one 10-minute lesson a day (the senpai AI teaching on a board) plus the review questions made from it. Premium: 20-minute lessons, several a day (fair-use cap), review history, calling your senpai back by voice on a gap, and a study plan with your senpai.
To reach the paywall (no photo needed): launch the app (no sign-in), open the "Settings" tab and tap "Subscription > Get Premium". It also opens from the "Plan" tab ("Make a plan with senpai"), from "Get more lessons" at the bottom of Home, right after the day's free lesson ends, and from "Ask senpai" on the review screen. Pick "Weekly", then "Start with this plan".
The paywall always states that the subscription auto-renews and can be cancelled at any time, and links to the Terms and Privacy Policy. "Keep using the free version" dismisses it without purchase. No countdowns or pressure. Prices are the strings returned by the store.
Restore: "Restore purchases" on the paywall. Cancel / change plan / refund: "Manage subscription" on Home, shown to subscribers only.
Purchasable with a Sandbox account; no account registration needed. The free tier's daily lesson time resets at midnight.
```

#### 月間プラン(`jp.co.aisensei.premium.monthly`)

```
■ 商品
カタルテ Premium（月額・自動更新）。¥2,980 / 1か月（米国 $19.99）。
週・月・年の3プランは同一サブスクリプショングループにあり、解放される機能はすべて同じです（期間と価格のみが異なります）。

■ 解放される機能
無料版は1日1回・最長10分の授業（先輩AIの板書つき解説）と、そこから作られる復習問題。Premium で、1回最長20分の授業を1日に続けて何問も教わる（フェアユース上限あり）、復習問題の履歴、穴を先輩に声で聞き直す授業、先輩との学習計画が使えます。

■ ペイウォールへの到達手順（写真撮影は不要です）
1. アプリを起動（サインイン・アカウント作成はありません。匿名の端末IDのみ）
2. 下部タブの「設定」を開き「契約 ＞ Premium にする」をタップ → ペイウォールが開きます（ほかに、下部タブ「計画」→「先輩と計画をつくる」、ホーム下部の「もっと教わる」、無料の1回を使い終えた直後の画面、復習画面の「先輩に聞く」からも開きます）
3. 週・月・年の3プランが並びます。「1か月」を選んで「このプランではじめる」

■ 表示していること
自動更新であること、いつでも解約できること、利用規約とプライバシーポリシーへのリンクをペイウォール上に常時表示しています。「無料のまま続ける」で購入せずに離脱できます。カウントダウン等の煽りはありません。価格はストアが返した文字列をそのまま表示しています。

■ 復元・解約
復元: ペイウォールの「購入を復元する」
解約/プラン変更/返金申請: 契約者のみホームに出る「サブスクリプションの管理」

■ 動作確認
Sandbox アカウントでそのまま購入できます。アカウント登録は不要です。無料版の1日の持ち時間は日付が変わると戻ります。

--- English ---
Katarute Premium (monthly, auto-renewing): JPY 2,980 / USD 19.99 per month. The weekly, monthly and yearly plans are in one subscription group and unlock identical features; only the period and price differ.
Free tier: one 10-minute lesson a day (the senpai AI teaching on a board) plus the review questions made from it. Premium: 20-minute lessons, several a day (fair-use cap), review history, calling your senpai back by voice on a gap, and a study plan with your senpai.
To reach the paywall (no photo needed): launch the app (no sign-in), open the "Settings" tab and tap "Subscription > Get Premium". It also opens from the "Plan" tab ("Make a plan with senpai"), from "Get more lessons" at the bottom of Home, right after the day's free lesson ends, and from "Ask senpai" on the review screen. Pick "Monthly", then "Start with this plan".
The paywall always states that the subscription auto-renews and can be cancelled at any time, and links to the Terms and Privacy Policy. "Keep using the free version" dismisses it without purchase. No countdowns or pressure. Prices are the strings returned by the store.
Restore: "Restore purchases" on the paywall. Cancel / change plan / refund: "Manage subscription" on Home, shown to subscribers only.
Purchasable with a Sandbox account; no account registration needed. The free tier's daily lesson time resets at midnight.
```

#### 年間プラン(`jp.co.aisensei.premium.yearly`)

```
■ 商品
カタルテ Premium（年額・自動更新）。¥29,800 / 1年（米国 $199.99）。
週・月・年の3プランは同一サブスクリプショングループにあり、解放される機能はすべて同じです（期間と価格のみが異なります）。
月額プラン（¥2,980×12=¥35,760）に対して約17%割安で、ペイウォールでは「月あたり約¥2,483」としてストアの計算値を表示しています。

■ 解放される機能
無料版は1日1回・最長10分の授業（先輩AIの板書つき解説）と、そこから作られる復習問題。Premium で、1回最長20分の授業を1日に続けて何問も教わる（フェアユース上限あり）、復習問題の履歴、穴を先輩に声で聞き直す授業、先輩との学習計画が使えます。

■ ペイウォールへの到達手順（写真撮影は不要です）
1. アプリを起動（サインイン・アカウント作成はありません。匿名の端末IDのみ）
2. 下部タブの「設定」を開き「契約 ＞ Premium にする」をタップ → ペイウォールが開きます（ほかに、下部タブ「計画」→「先輩と計画をつくる」、ホーム下部の「もっと教わる」、無料の1回を使い終えた直後の画面、復習画面の「先輩に聞く」からも開きます）
3. 週・月・年の3プランが並びます。「1年」を選んで「このプランではじめる」

■ 表示していること
自動更新であること、いつでも解約できること、利用規約とプライバシーポリシーへのリンクをペイウォール上に常時表示しています。「無料のまま続ける」で購入せずに離脱できます。カウントダウン等の煽りはありません。価格はストアが返した文字列をそのまま表示しています。

■ 復元・解約
復元: ペイウォールの「購入を復元する」
解約/プラン変更/返金申請: 契約者のみホームに出る「サブスクリプションの管理」

■ 動作確認
Sandbox アカウントでそのまま購入できます。アカウント登録は不要です。無料版の1日の持ち時間は日付が変わると戻ります。

--- English ---
Katarute Premium (yearly, auto-renewing): JPY 29,800 / USD 199.99 per year. About 17% less than 12 monthly renewals (JPY 35,760); the paywall shows the store-calculated per-month equivalent (about JPY 2,483). The weekly, monthly and yearly plans are in one subscription group and unlock identical features; only the period and price differ.
Free tier: one 10-minute lesson a day (the senpai AI teaching on a board) plus the review questions made from it. Premium: 20-minute lessons, several a day (fair-use cap), review history, calling your senpai back by voice on a gap, and a study plan with your senpai.
To reach the paywall (no photo needed): launch the app (no sign-in), open the "Settings" tab and tap "Subscription > Get Premium". It also opens from the "Plan" tab ("Make a plan with senpai"), from "Get more lessons" at the bottom of Home, right after the day's free lesson ends, and from "Ask senpai" on the review screen. Pick "Yearly", then "Start with this plan".
The paywall always states that the subscription auto-renews and can be cancelled at any time, and links to the Terms and Privacy Policy. "Keep using the free version" dismisses it without purchase. No countdowns or pressure. Prices are the strings returned by the store.
Restore: "Restore purchases" on the paywall. Cancel / change plan / refund: "Manage subscription" on Home, shown to subscribers only.
Purchasable with a Sandbox account; no account registration needed. The free tier's daily lesson time resets at midnight.
```

---

## 8. App Review Information(アプリ側の審査メモ)

**ここが一番の関門。** 審査担当者は数学のノートを持っていない。撮影から先に進めずリジェクト、が
現実的に一番ありうる詰まり方なので、**サンプルノート画像のURL(`<SAMPLE_NOTES_URL>`)を必ず埋める**。
日本語を話せない担当者でも「うまく言えない」→「わかった」で祝福画面まで届くことも明記してある。

連絡先: 氏名・電話・メール(`kfukejob@gmail.com`)。デモアカウント: 不要(サインインなし)。

### JA
```
■ アカウント不要
サインイン/アカウント作成はありません。匿名の端末IDだけで利用できます。

■ 動作確認の手順
1. ホームの「先輩に教わる」→ カメラで撮る、またはアルバムから写真を選ぶ
   → 審査用のサンプルノート画像はこちら: <SAMPLE_NOTES_URL>
2. 読み取った単元のチップを確認して、はじめる
3. 先輩AIが板書つきで教えます。声で答えると会話が進みます。
   日本語を話さずに進める場合は「うまく言えない」をタップするか、板書が出たところで
   画面下の「わかった」を押してください。祝福画面まで到達し、裏で復習問題が作られます。
   （途中でやめる場合は左上の × →「今日はここまで」）
4. 復習問題は「わかった」の3日後・7日後に通知で届きます（テキストで回答。不正解は翌日から再出題）。
   ホームには、出題日が来た問題だけが「解きにいく問題」として並びます。

■ 権限の求めどころ
カメラ＝撮影の直前 ／ マイク＝会話の直前 ／ 通知＝初回の祝福画面。
起動時にまとめて求めることはしません。

■ AIが生成する内容の安全対策
・授業と復習問題は、カリキュラム許可リスト（公開リポジトリ同梱の curriculum JSON）に載っている単元からのみ生成します。対象は中学数学・高校数学・中学英語・高校英語で、写真の内容と許可リストが重なる範囲を外れた出題はサーバ側で弾いています。
・板書に出せる数式コマンドと図形も許可リスト方式で照合しています（packages/guardrail）。
・不適切な内容の報告導線を「設定 ＞ 気になった内容を報告する」に用意しています。

■ App内課金の確認
Premium（週 ¥980 ／ 月 ¥2,980 ／ 年 ¥29,800、自動更新）。Sandbox アカウントで購入できます。
ペイウォールへは、写真を撮らなくても 下部タブ「計画」→「先輩と計画をつくる」から到達できます。
無料版は1日1回の授業（最長10分）で、上限は日付が変わると戻ります。

■ 通知
復習のリマインダー（3日後・7日後。不正解なら翌日も）。初回の祝福画面で許可を求めます。
```

### EN
```
■ No account required
There is no sign-in or account creation. The app works with an anonymous device ID.

■ How to walk through the app
1. Tap "Get taught by your senpai" on Home — use the camera, or pick from the photo library.
   Sample notebook images for review: <SAMPLE_NOTES_URL>
2. Confirm the detected topic chips and start.
3. The senpai AI teaches on the board. Answer out loud to continue.
   To proceed without speaking, tap "I can't explain this yet", or tap "Got it" at the bottom
   once the board has appeared. You will reach the celebration screen and a review question is
   created in the background. (To quit midway: × at the top left, then "That's it for today".)
4. Review questions arrive as notifications 3 and 7 days after "Got it" (text answers; wrong
   answers come back the next day). Home lists only the questions whose day has come.

■ When permissions are requested
Camera: right before taking a photo. Microphone: right before the conversation.
Notifications: on the first celebration screen. Never all at launch.

■ Safety of AI-generated content
- Lessons and review questions are generated only from topics on an allowlist (the curriculum
  JSON included in the public repository) — junior-high and high-school mathematics and
  English — and anything outside the overlap of the photo and that allowlist is rejected server-side.
- The board's LaTeX commands and figure primitives are allowlisted as well (packages/guardrail).
- A report path is provided at Settings > "Report something that felt wrong".

■ In-app purchase
Premium (weekly $6.99 / monthly $19.99 / yearly $199.99, auto-renewing). Purchasable with a
Sandbox account. The paywall is reachable without a photo: "Plan" tab > "Make a plan with senpai".
The free tier allows one lesson per day (up to 10 minutes); the limit resets daily.

■ Notifications
Review reminders 3 and 7 days after a lesson (and the next day after a wrong answer),
requested on the first celebration screen.
```

---

## 9. App のプライバシー(データ収集の申告)

**これを「公開」するまで「審査に追加」が押せない**("an Admin must provide information about the app's
privacy practices")。Account Holder / Admin のロールで、マイ App → カタルテ → 一般 → 「App のプライバシー」。

1. **プライバシーポリシー**: 日本語 `https://ubiqy.jp/privacy/`、英語(米国) `https://ubiqy.jp/en/privacy/`。
   「ユーザーのプライバシー選択URL」は空でよい
2. **データ収集** → 開始 → 「このAppからデータを収集していますか?」→ **はい**
3. データタイプにチェック → 保存 → タイプごとに3問(用途 / 識別情報と関連付け / トラッキング)に答える
4. 右上の **公開**。公開されて初めてバージョンの「審査に追加」が通る

根拠は [`../ci/store-setup.md`](../ci/store-setup.md) 1-7 と実装(2026-09-05):
API は `x-device-id`、RevenueCat は `appUserID` = 端末ID(+ IDFV)、OneSignal は `login(端末ID)` +
プッシュトークン、Sentry は `sendDefaultPii = false` + `beforeSend` で本文を落としていてユーザーIDを付けない。
プライバシーポリシー第4条(改善のための利用)を書いた分、写真・音声・回答の用途に「分析」を足す。

| カテゴリ | データタイプ | 収集 | 用途 | ユーザーの識別情報と関連付け | トラッキング |
| --- | --- | --- | --- | --- | --- |
| ユーザーコンテンツ | 写真またはビデオ(問題・ノートの写真) | する | Appの機能、分析 | **する**(端末ID) | しない |
| ユーザーコンテンツ | オーディオデータ(会話 → 文字起こし) | する | Appの機能、分析 | する | しない |
| ユーザーコンテンツ | その他のユーザーコンテンツ(復習問題への回答テキスト) | する | Appの機能、分析 | する | しない |
| ID | ユーザーID(匿名の端末UUID。API / RevenueCat / OneSignal の外部ID) | する | Appの機能 | する | しない |
| ID | デバイスID(RevenueCat の IDFV、OneSignal のプッシュトークン) | する | Appの機能 | する | しない |
| 購入 | 購入履歴(RevenueCat) | する | Appの機能 | する | しない |
| 使用状況データ | 製品の操作(授業回数・連続日数・通知の開封) | する | Appの機能、分析 | する | しない |
| 診断 | クラッシュデータ(Sentry) | する | Appの機能 | **しない** | しない |
| 診断 | その他の診断データ(板書の縮退などの警告。Sentry) | する | Appの機能 | しない | しない |

**チェックしないもの**: 連絡先情報(氏名・メール・電話・住所)、健康とフィットネス、金融情報、位置情報
(OneSignal の位置情報モジュールはビルドから外してある)、機密情報、連絡先、閲覧履歴、検索履歴、
パフォーマンスデータ(Sentry の `tracesSampleRate = 0`)、その他のデータ。

トラッキングはすべて「しない」。広告SDKを入れておらず、他社アプリ/サイトを横断する追跡をしない
(ATT のダイアログも不要)。サポートフォームで任意に書いてもらうメールアドレスは**アプリの外**(Web)なので、
ここには入らない。
