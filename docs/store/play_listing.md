# Google Play — store listing (common text assets)

The text to paste directly into Play Console >
**Store listing > Common text assets**. The App Store side's metadata is in
[`../design_direction_v0.html#store`](../design_direction_v0.html)
(updated to the post-2026-08-09 wording and the four curricula's subjects).
**When changing the wording, change both.**

The Apple subscription boilerplate (Apple ID, "Settings > Apple ID > Subscriptions")
**is not written for Google**. Cancellation happens elsewhere, so reusing it would state
something untrue.

| Field | Limit | Current |
| --- | --- | --- |
| App name | 30 chars | **カタルテ** (see the note below) |
| Short description | 80 chars | JA / EN below |
| Full description | 4000 chars | JA / EN below |
| App icon | 512x512 / 32-bit PNG / under 1MB | [`icon/play-store-512.png`](icon/play-store-512.png) |
| Feature graphic | 1024x500 | [`feature-graphic/ja-1024x500.png`](feature-graphic/ja-1024x500.png) (ja and en) |
| Screenshots (phone) | 2+, between 9:16 and 16:9 | [`screenshots/{ja,en}/play/`](screenshots), five at 1080x1920 |
| Screenshots (7-inch) | Optional | [`screenshots/{ja,en}/play-tablet-7/`](screenshots), five at 1200x1920 |
| Screenshots (10-inch) | Optional | [`screenshots/{ja,en}/play-tablet-10/`](screenshots), five at 1600x2560 |

## A note on the app name

Play Console currently has **`かたるて` (hiragana)**. The repository, the landing page
and the in-app wording are all **`カタルテ` (katakana)**, and the basic information in
`docs/design_direction_v0.html` also says "カタルテ (kataru x karte)".
**Align the console to katakana** (every existing asset is on that side).

The display name installed on the device is already fixed to `カタルテ`:

- `android:label` in `apps/mobile/android/app/src/main/AndroidManifest.xml`
- `CFBundleDisplayName` in `apps/mobile/ios/Runner/Info.plist`

A store name differing from the launcher name means people cannot find the app after
installing. To use different display names per language (shipping `Katarute` to English
markets, say), iOS needs per-locale `InfoPlist.strings` and Android needs
`values-<locale>/strings.xml` — **for now both locales share `カタルテ`**.

---

## Short description (80 chars)

### JA / 37 chars

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
```

---

## Full description (4000 chars)

Play has no bold or other decoration, so headings are made with `■` and line breaks alone.

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
```

---

## Generating the assets

Everything is written out from the real screens and from code by scripts in
`apps/mobile/tool/`.
**Never redraw an image by hand** (code is authoritative for visuals).

```bash
cd apps/mobile
fvm flutter test tool/generate_app_icon.dart          # the icon (including 512)
fvm flutter test tool/generate_store_screenshots.dart # screenshots + the feature graphic
```

### Screenshots

| Frame | Output | Logical size used for rendering |
| --- | --- | --- |
| Phone | `screenshots/{ja,en}/play/` 1080x1920 | 393x852 |
| 7-inch tablet | `screenshots/{ja,en}/play-tablet-7/` 1200x1920 | 600x960 |
| 10-inch tablet | `screenshots/{ja,en}/play-tablet-10/` 1600x2560 | 800x1280 |

- **Do not reuse the App Store's `captioned/` (1290x2796) for Play.** Play restricts the
  aspect ratio to between 16:9 and 9:16, and 1:2.17 is taller than 9:16, so it is rejected
- Tablets are **really rendered at tablet width**. Stretching a device image produces a
  picture that differs from the real device (avoided for the same reason as App Review
  guideline 2.3.3)
- A heading that wraps to two lines would overlap the device image, so the device's
  position is derived from the heading's **measured height**

### Feature graphic

`feature-graphic/{ja,en}-1024x500.png`. The background is the same pale blue gradient as
the screenshots, and the artwork is the same mark as the icon. Elements near the edges get
cropped, so the inner 72px is kept clear.

## Icon (512x512)

`apps/mobile/tool/generate_app_icon.dart` writes it out from
`lib/src/brand/app_mark.dart`. **Never redraw the image by hand.**

```bash
cd apps/mobile
fvm flutter test tool/generate_app_icon.dart
```

- Output: `docs/store/icon/play-store-512.png` (512x512 / RGBA / about 15KB)
- Rounded corners and the drop shadow are **added by Google**, so hand it over square
- Play allows alpha, so there is no need to flatten it as with iOS's 1024

## URLs

| Declared as | URL |
| --- | --- |
| Privacy policy (required) | `https://ubiqy.jp/privacy/` |
| Terms of service | `https://ubiqy.jp/terms/` |

The app receives the same values via `--dart-define` (`PRIVACY_POLICY_URL` /
`TERMS_URL`). Which of these and the two pages in `apps/lp/public/{privacy,terms}/` is
authoritative is undecided ([`../ci/store-setup.md`](../ci/store-setup.md) 0-2).

## Still to fill in

- **Play Console's app name is `かたるて` (hiragana)** — fix it to `カタルテ` in the
  console. The device display name (`android:label` / `CFBundleDisplayName`) is already
  fixed to `カタルテ`
- The support URL (one page pointing at the same channel as `SUPPORT_EMAIL`)
- The subscription's price and period (`pivot_plan_v1.md` §6-2, after measuring costs)
