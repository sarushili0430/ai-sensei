# Google Play — ストアの掲載情報(共通のテキスト要素)

Play Console > **ストアの掲載情報 > 共通のテキスト要素**(Common text assets)に
そのまま貼るための本文。App Store 側のメタデータは
[`../design_direction_v0.html#store`](../design_direction_v0.html) にある
(2026-08-09 のピボット後の言い方と、4課程ぶんの対応科目に更新済み)。
**言い回しを変えるときは両方を直すこと。**

Apple 向けの定期購入の定型文(Apple ID・「設定 > Apple ID > サブスクリプション」)は
**Google では書かない**。解約先が違うので、そのまま流用すると事実と食い違う。

| フィールド | 上限 | 現状 |
| --- | --- | --- |
| アプリ名 | 30字 | **カタルテ**(下記の注意) |
| 短い説明 | 80字 | 下記 JA / EN |
| 詳しい説明 | 4000字 | 下記 JA / EN |
| アプリアイコン | 512×512 / 32bit PNG / 1MB以内 | [`icon/play-store-512.png`](icon/play-store-512.png) |
| フィーチャーグラフィック | 1024×500 | [`feature-graphic/ja-1024x500.png`](feature-graphic/ja-1024x500.png)(日英) |
| スクリーンショット(スマホ) | 2枚以上・9:16〜16:9 | [`screenshots/{ja,en}/play/`](screenshots) 1080×1920 が5枚 |
| スクリーンショット(7インチ) | 任意 | [`screenshots/{ja,en}/play-tablet-7/`](screenshots) 1200×1920 が5枚 |
| スクリーンショット(10インチ) | 任意 | [`screenshots/{ja,en}/play-tablet-10/`](screenshots) 1600×2560 が5枚 |

## アプリ名の注意

Play Console 側が **`かたるて`(ひらがな)** になっている。リポジトリと
LP・アプリ内文言はすべて **`カタルテ`(カタカナ)** で、
`docs/design_direction_v0.html` の基本情報も「カタルテ(語る × カルテ)」。
**どちらかに寄せること。** 寄せる先はカタカナを推奨(既存資産が全部そちら)。

あわせて、端末に入る表示名が `ai-sensei` のままなのも未修整:

- `apps/mobile/android/app/src/main/AndroidManifest.xml` の `android:label`
- `apps/mobile/ios/Runner/Info.plist` の `CFBundleDisplayName`

ストア名とランチャー名が違うと、インストール後にアプリを見つけられない。

---

## 短い説明(80字)

### JA / 37字

```
答えを教える。そのあと、あなたに教え返してもらう。中学・高校の数学と英語。
```

### EN / 80 chars

```
The AI tutor that teaches you high school math — then asks you to teach it back.
```

---

## 詳しい説明(4000字)

Play は太字などの装飾を持たないので、見出しは `■` と改行だけで作る。

### JA

```
答えを教える。そのあと、あなたに教え返してもらう。

わからない問題を撮ると、先輩AIが板書つきで教えてくれます。そのあとすぐ、「じゃあ今の、説明してみて」。説明が止まった場所が、自分でも気づいていなかった「理解の穴」としてカルテに残ります。

■「読めばわかる」と「説明できる」は、別物です
写真を撮れば答えが出るアプリは、もう高校生の手元にあります。答えの入手コストはゼロになりました。それなのに模試で解けないのは、解答を読んで「わかった」と感じた状態と、自分の言葉で手順と理由を説明できる状態が別物だからです。しかもこの2つは、本人には区別がつきません。カタルテは答えを配る側ではなく、穴を見つける側のアプリです。

■ やることは、4つ
1. わからない問題を撮る。ノートもあれば一緒に撮ってください（どこまで書けたのかを先輩が見ます）。手も付けられなかった問題なら、問題だけで大丈夫です
2. 先輩が板書つきで教えます。数式・計算・図は板書に書き、声は「ここ、Dを見てほしいんだけど — プラスだよね。だから?」と問いかけるだけ
3. 「じゃあ今の、説明してみて」。答えはもう板書に出ています。それでも説明できるとは限らない、というのがこのアプリの主張です
4. 説明が止まった場所が「理解の穴」としてカルテに残ります

数式を音声で読み上げません（「エックスのにじょうマイナス3エックス…」は聞いても頭に入らないため）。書いている間は喋らない、というのは本物の家庭教師と同じやり方です。

■ カルテ — 点数ではなく、穴が残る
1回の授業のあとに残るのは、次の3つだけです。
・言えたこと — 教え返せたところに、黄色のマーカーが引かれます
・穴 — 説明が止まったところ。失点ではなく「これから埋まる場所」です
・用語メモ — 混ざっていた言葉。「解の公式」と「判別式」など

正答率も偏差値も出しません。ランキングも、他人と比べる画面もありません。数えるのは、続けた日数と、埋めた穴の数だけです。

■ 埋まるまで、先輩がもう一度たずねます
見つかった穴は、あした・3日後・7日後にもう一度きかれます。忘れかけた頃にもう一度思い出すほど記憶に残る、という間隔反復を「先輩からのおさらい」の形にしました。急かす通知は送りません。

入口は1問10秒のテキストの小テストなので、電車でもリビングでも深夜でも回せます。採点するのはAIではなく、あなた自身です（「言えた / まだ言えない」の自己申告）。出題元は、あなたが説明した内容から作ります。

■ 4つの約束
1. 教える。そのあと教え返させる。教えて終わりにはしません
2. 点数を出さない。数えるのは、続けた日数と、埋めた穴の数だけ
3. パスを恥にしない。「うまく言えない」は、いつでも押せます
4. 煽らない。通知も有料プランの案内も、命令や催促にはしません

■ 背景にある考え方
人は、誰かに教えようとした瞬間にはじめて、自分の理解の穴に気づきます。学習科学でいう自己説明効果（self-explanation effect）と、教えることで学びが深まるプロテジェ効果（teachable agent）です。カタルテは、この2つを1周のなかに畳み込んでいます。

■ 対応範囲
・科目: 中学数学（中1・中2・中3）／高校数学（数I・A・II・B・III・C）／中学英語（文法事項・文構造）／高校英語（英語コミュニケーションI・II、論理表現I）
・中学生か高校生かを設定で選ぶと、その段階の単元だけが候補に出ます
・言語: 日本語 / English。海外の学習者には海外の課程（Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics）で単元を出します
・必要なもの: カメラ（問題とノートの撮影）とマイク（教え返し）。許可を求めるのは、使う直前だけです
・アカウント作成は不要です。サインインもメールアドレスの登録もなく、匿名の端末IDだけではじめられます

■ 料金
無料 — 毎日1問、先輩に教わる／その日のカルテ／穴の復習（10秒の小テスト）
Premium — 毎日、続けて何問も／穴の復習と履歴／先輩のあと追い質問

価格と無料期間は Google Play の表示のとおりです。定期購入は自動更新され、Google Play ストアの「お支払いと定期購入」からいつでも解約できます。

■ 写真と音声の扱い
ノートの写真と、会話の文字起こしを、カルテを作るために保存します。匿名の端末IDにひもづき、氏名やメールアドレスは取得しません。広告は出しませんし、他社サービスをまたぐ追跡もしません。

あわせて、説明の分かりにくさや誤りを見つけてサービスを改善するためにも使います。無料プランではこの利用が前提ですが、Premium ではアプリの設定からオフにできます。詳しくはプライバシーポリシーをご覧ください。

■ 先輩が間違えることもあります
ありえます。だからこそ「教えて終わり」にしていません。あなたが教え返すときに説明が破綻することで、先輩の誤読が表に出ます。気になった説明・板書・質問は、アプリの設定から報告できます。

ソースコードは MIT ライセンスで公開しています。
https://github.com/sarushili0430/ai-sensei
```

### EN

```
The AI tutor that teaches you — then asks you to teach it back.

Photograph a problem you are stuck on and a senpai — an older student — teaches it, writing on a board as they go. Then, right away: "Now explain it back to me." Wherever your explanation stalls becomes a gap you did not know you had, and it stays in your karte.

■ "I understood it" and "I can explain it" are not the same thing
Answers cost nothing now — a photo gets you one instantly. If you still cannot solve the problem on the exam, it is because reading a worked solution and saying the steps and the reasons in your own words are two different states, and you cannot tell them apart from the inside. This app is not on the side that hands out answers; it is on the side that finds the gaps.

■ Four steps
1. Photograph the problem, with your notes if you have them, so your senpai can see how far you got. Stuck from the start? The problem alone is fine
2. Your senpai teaches it on the board. Equations, calculations and figures are written, not spoken — the voice only asks: "Look at D here. It's positive, right? So?"
3. "Now explain it back to me." The answer is already on the board — being able to explain it anyway is a different matter
4. Wherever you stall is recorded as a gap in your karte

Equations are never read aloud: a spoken formula does not stay in your head. Staying quiet while writing is how a real tutor works.

■ Karte — no score, just gaps
After a lesson, only three things remain:
- What you explained — marked in yellow
- Gaps — where your explanation stalled. Not points lost; places about to be filled
- Terms you were mixing up, such as "quadratic formula" and "discriminant"

No accuracy rate, no ranking, no screen that compares you to anyone else. We count days in a row and gaps filled.

■ Your senpai asks again until the gap is filled
Every gap comes back tomorrow, in 3 days and in 7 days — spaced repetition, written as a follow-up from your senpai rather than a nag. A review takes 10 seconds and is text only, so it works on the train or late at night. You do the grading, not the AI ("I could say it" / "not yet").

■ Four promises
1. We teach you — then have you teach it back. We never stop at teaching
2. No scores. We count days in a row and gaps filled, nothing else
3. Passing is never shameful. "I can't say it" is always one tap away
4. No pressure. Notifications and upgrade prompts are never commands or nagging

People notice the holes in their own understanding only when they try to explain — the self-explanation and protégé effects, folded into a single loop.

■ Scope
- Subjects: high school mathematics (Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics)
- Languages: Japanese and English
- What you need: a camera and a microphone, requested only right before use
- No account, no sign-in, no email address — just an anonymous device ID

■ Pricing
Free — one lesson a day, today's karte, and 10-second gap reviews
Premium — as many lessons a day as you like, gap review and history, follow-up questions

Prices and any free period are as shown on Google Play. Subscriptions renew automatically and can be cancelled any time in the Play Store under Payments and subscriptions.

■ Photos and audio
Photos of your notes and transcripts of your conversations are stored to build your karte. They are tied to an anonymous device ID; we do not collect your name or email address. There are no ads and no cross-service tracking.

They are also used to find unclear or incorrect explanations and improve the service — a condition of the free plan, which Premium can turn off in settings. See the privacy policy for details.

■ Your senpai can be wrong
It can — which is exactly why we do not stop at teaching. When you explain it back, a misread on the AI's part shows up as an explanation that does not hold together. Anything it says can be reported from settings.

Open source under the MIT license.
https://github.com/sarushili0430/ai-sensei
```

---

## 素材の生成

すべて `apps/mobile/tool/` のスクリプトが実画面とコードから書き出す。
**画像を直接描き直さないこと**(絵の正はコード側)。

```bash
cd apps/mobile
fvm flutter test tool/generate_app_icon.dart          # アイコン(512含む)
fvm flutter test tool/generate_store_screenshots.dart # スクショ + フィーチャーグラフィック
```

### スクリーンショット

| 枠 | 出力 | 描画に使う論理サイズ |
| --- | --- | --- |
| スマートフォン | `screenshots/{ja,en}/play/` 1080×1920 | 393×852 |
| 7インチ タブレット | `screenshots/{ja,en}/play-tablet-7/` 1200×1920 | 600×960 |
| 10インチ タブレット | `screenshots/{ja,en}/play-tablet-10/` 1600×2560 | 800×1280 |

- **App Store の `captioned/`(1290×2796)を Play に流用しないこと。** Play は
  縦横比を 16:9〜9:16 に制限していて、1:2.17 は 9:16 より縦長なので弾かれる
- タブレットは**タブレット幅で本当に描画**している。端末画像を引き伸ばすと
  実機と違う絵になる(App Review のガイドライン 2.3.3 と同じ理由で避ける)
- 見出しが2行になると端末画像に食い込むので、端末の位置は見出しの**実測高さ**から決めている

### フィーチャーグラフィック

`feature-graphic/{ja,en}-1024x500.png`。地はスクショと同じ淡い青の
グラデーション、絵柄はアイコンと同じマーク。端に寄せた要素は切られるので
内側72pxは空けている。

## アイコン(512×512)

`apps/mobile/tool/generate_app_icon.dart` が
`lib/src/brand/app_mark.dart` から書き出す。**画像を直接描き直さないこと。**

```bash
cd apps/mobile
fvm flutter test tool/generate_app_icon.dart
```

- 出力: `docs/store/icon/play-store-512.png`(512×512 / RGBA / 約15KB)
- 角丸とドロップシャドウは**Google側が付ける**ので、四角いまま渡す
- Play はアルファを許すので、iOS の1024のようにアルファを落とす必要はない

## まだ埋まっていないもの

- プライバシーポリシー / 利用規約 の公開URL(`apps/lp` の2ページを配信する)
- アプリ名の表記統一(上記)とランチャー表示名の修整
