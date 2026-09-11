# Devpost 提出フォーム — 貼る文面(RevenueCat Shipaton 2026)

[Devpost の提出フォーム](https://devpost.com/submit-to/29969-revenuecat-shipaton-2026)の各欄に
**そのまま貼るための本文**。正はここ。提出締切は **2026-09-30 23:45 PDT**。

- 製品の言い方は [ADR 0009](adr.md#adr-0009) の一本道に揃える:
  **撮る → 板書つきで教わる → 「わかった」→ その板書から復習問題1問 → 3日後・7日後に通知 → テキストで答えてAIが採点**。
  「教え返し」「カルテ」「言えた / まだ言えない」「答えを教えない」「正答率」「偏差値」は**書かない**
  ([`store/app_store_listing.md`](store/app_store_listing.md) と同じ禁止語)。
- 名前は英語圏 `Katarute` / 日本語 `カタルテ`。**ストア名・ランチャー名と1文字も違えないこと**
  (食い違いで Guideline 4 に触れた経緯が [`release.md` §0-1](release.md))。
- 文字数は各欄の上限に収めてある(プロジェクト名 60・エレベーターピッチ 200・タグ 25個)。
  **変えたら数え直すこと。** 数え方は `[...s].length`(絵文字を入れないので見た目の字数と一致する)。
- 審査員は英語で読む。**日本語訳は載せない**(Devpost 側は英語一本。日本語の文面が要るのはストアだけ)。

---

## 0. 提出要件(2026-09-11 に一次情報を確認)

出典は [公式ルール](https://revenuecat-shipaton-2026.devpost.com/rules)・
[FAQ](https://www.shipaton.com/faq)・
[提出の手引き](https://www.revenuecat.com/blog/engineering/how-to-submit-your-app-for-shipaton)・
[準備の codelab](https://revenuecat.github.io/codelabs/shipaton-2026-prep.html)。
**更新されうるので、提出直前にもう一度読むこと。**

### 0-1. 全カテゴリ共通で必ず出すもの

| 要件 | 原文 | いまの状態 |
| --- | --- | --- |
| RevenueCat SDK で最低1つの App内課金(または RevenueCat Ads) | "uses the RevenueCat SDK to power at least one in-app or web purchase" | ✅ `purchases_flutter`([`revenuecat.md`](revenuecat.md)) |
| 機能の説明(テキスト) | "explain the features and functionality of your Project" | ✅ §4 |
| デモ動画 **2分未満** | "should be less than two (2) minutes" / "footage that shows the Project functioning on the device" | ❌ 未作成。YouTube か Vimeo、**限定公開は可・非公開は不可** |
| **公開済みの**ストアURL | App Store / Google Play / Mac App Store / Samsung Galaxy Store。**米国から見えること** | ❌ 審査中(§3) |
| **1024×1024 のアプリアイコン** | "Include a 1024x1024 app icon" | ✅ `apps/mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png`(不透明・角を丸めていない生の正方形) |
| **1179×2556 のスクショを1枚以上・端末フレームなし** | "at least one screenshot ... WITHOUT device frames" | ✅ [`store/screenshots/{ja,en}/plain/`](store/screenshots)(まさにこの寸法で描いてある) |
| 審査員が有料機能を開けること | "the app must either offer a free trial or the Entrant must include a promo code for judges" | ❌ プロモコード未発行。**無料トライアルを付けていないので、コードが要る** |
| **英語** | "All Submission materials must be in English or ... provide an English translation" | ⚠ Devpost 側は英語で書く(§1〜§4)。スクショの中身も英語にした(2026-09-11。板書・復習問題がロケールで切り替わるようにした)。**リポジトリの README は日本語のまま**(Next Gen を狙うなら効く。0-4) |

### 0-2. 落ちる条件(ここが今回の勝負どころ)

- **「審査中」は失格。** "Your app must be published on the app stores so judges can download and review it. Apps under review don't qualify."
- **Shipaton の期間中に初めて公開したアプリであること。** 8/1 より前にどこかのストアで公開していたものは、別ストアに出し直しても不可。
  → ai-sensei は**一度も公開していない**ので条件を満たす。1.0 (50) のリジェクトは「未公開」のままなので問題にならない。
- **Web アプリは不可**(iOS / iPadOS / macOS / Android)。
- 推奨は **9/23 までに公開**(締切の1週間前。codelab の目安)。審査は数日かかる。

### 0-3. 日程(すべて PDT)

| | |
| --- | --- |
| 提出期間 | 2026-07-31 08:00 〜 **2026-09-30 23:45** |
| 審査 | 2026-10-01 〜 10-13 |
| 発表 | 2026-10-21 |

### 0-4. 併願するカテゴリごとの追加要件

| カテゴリ | 追加で出すもの | いまの状態 |
| --- | --- | --- |
| **OneSignal「Keep Them Coming Back」**(1位 $25,000) | ①ライブのアプリ ②**OneSignal の API / MCP / ダッシュボードで campaign を1つ以上作って配信** ③**OneSignal App ID を書く** ④どう使ったかの説明 | ⚠ App ID はある(`47044c5e-15eb-49ec-bdd4-e0ed2219a799`)。**「campaign を作って配信した」と言えるかは要確認** —— いまは `/complete` から REST で個別に予約しているだけ |
| **#BuildInPublic**(1位 $30,000) | ①**公開の投稿へのリンク**("links to any relevant social accounts and/or links to specific content") ②公開で作ったことがどう効いたかの短い説明 | ❌ **public リポジトリだけでは足りない見込み。** 開発中のSNS投稿が無いなら、ここは取りに行かないほうがいい |
| **Next Gen**(1位 $20,000・学生) | ①**学籍メール**(高校/大学/ブートキャンプ等の在学者) ②デモ動画 ③**public なリポジトリ + OSSライセンスファイル** ④セットアップ手順。**ストア公開も開発者アカウントも不要** | ⚠ MIT + public は ✅。**README が日本語**なので、英語の手順が要る |
| **Peace Prize**(1位 $20,000) | 個人・コミュニティ・社会にどう役立つ設計かの説明 | ✅ §5 に根拠(無料のまま毎日1回・点数と順位を持たない) |
| **HAMM**(1位 $20,000) | ビジネスモデル・価格・ペイウォール・転換の説明 | ✅ [`business/pricing_v1.md`](business/pricing_v1.md) |
| **Design**(1位 $20,000) | 見どころの説明(craft を見る。事業性は見ない) | ✅ 板書・生成がコード |

Influencer 系は**1つのカテゴリにしか出せない**が、それ以外は併願に制限は書かれていない。

### 0-5. Devpost のどの欄に何を置くか

- **1024×1024 のアイコンと 1179×2556 のスクショは、Project details の画像ギャラリーに上げる。**
  Additional info の `Did you attach a 1024 x 1024 uncropped image of your app icon?` は、
  **それを上げたかの確認**で、ここが画像のアップロード欄ではない。
  *uncropped* = **角を丸めたり切り抜いたりしていない生の正方形**。
  上の `Icon-App-1024x1024@1x.png` がまさにそれ(Apple も同じ形を要求するので、
  角丸もアルファも入っていない)。
- 3:2 のサムネイルは Project overview(§1)。
- カテゴリごとの説明(0-4 の「追加で出すもの」)は Additional info。

---

## 1. Project overview

### Project name(60字)

```
Katarute
```

ストアの名前(`Katarute` / `カタルテ`)と揃えるので**アプリ名だけ**にする。
審査員は Devpost を見たあと App Store を引くので、ここで別名を名乗ると探せなくなる。
タグラインはすぐ下の Elevator pitch が担当する。

> 副題を付けたい場合の候補(51字): `Katarute — taught on a board, asked again in 3 days`

### Elevator pitch(200字)

```
An AI tutor that teaches the problem you photographed on a live whiteboard, then asks you one question from it 3 days later. Every tutor teaches; almost none come back to see whether it stuck.
```

192字。**立てているのは「家庭教師」ではなく「家庭教師がやらない側」。**

教える主体を家庭教師に寄せるのは、審査員が1語で受け取れるから
(ストア文面も「書いている間は喋らない、というのは**本物の家庭教師と同じやり方**です」と、
同じ比喩を1か所だけで使っている。キーワードにも `家庭教師` が入っている)。
ただし "AI tutor" は Devpost でもっとも飽和した言い方で、それだけでは山に埋もれる。
**火曜に教えた人は、金曜にそれが残っているかを確かめない** — ユニークなのはそこで、
後半の一文がその役をしている。

書かなかったものと、その理由:

- **`senpai` はここに入れない。** 英語の審査員には意味の無い音で、説明に字数を食う。
  人格は Project details の What it does 側で出す(§4 はそう書いてある)。
- **「ずっと見てくれる関係」を約束しない。** tutor と言った瞬間に進捗管理や学習計画まで
  期待されるが、いまの実装は **1授業 → 1問 → 3日後・7日後**。デモで足が出る言い方はしない。
- 3日後だけを書いて7日後を落としたのは字数の都合。**通知が2回あるのは事実**なので、
  Project details 側では両方書く。

差し替え候補(いずれも上限内):

| 字数 | 本文 | 寄せている先 |
| --- | --- | --- |
| 190 | `An AI tutor that teaches the problem you photographed on a live whiteboard, then follows up 3 and 7 days later with one question from it. Other apps hand you the answer and never check back.` | 家庭教師と、答えを配るアプリとの対比を1文ずつ |
| 186 | `A senpai AI teaches the problem you photographed on a live whiteboard, then sends one question from that board back in 3 and 7 days. Photo-search apps hand you the answer and stop there.` | senpai を残し、写真検索アプリとの対比を立てる |
| 185 | `Photograph a problem you're stuck on and a senpai AI teaches it on a live whiteboard, never reading the equations aloud. Tap "Got it" and one question from that board returns in 3 days.` | 板書(数式を読み上げない)を立てる |
| 166 | `Taught on a board, asked again in 3 days. A senpai AI teaches the problem you photographed, then asks you one question from that board just as you start to forget it.` | ストアのサブタイトルと同じ入り |
| 181 | `An hour with a human tutor costs more than a month of this. Katarute teaches the problem you photographed on a live whiteboard, then comes back 3 days later to see whether it stuck.` | **値段で殴る**(所得に関係なく届く、を1行目に置く) |
| 191 | `An AI tutor that writes instead of talking: it fills a live whiteboard as it teaches your problem, never saying an equation out loud — then asks you one question from that board 3 days later.` | **板書の規律**(live whiteboard × AI を1行目に置く) |

下2つは「所得に関係なく持ち歩ける」「live whiteboard × AI が新しい」を主語にした版。
**どちらも主張としては正しいが、200字の1本目に置くのは勧めない。**

- **板書は、いまの本文にもう入っている**(`on a live whiteboard`)。
  ただし whiteboard という語だけでは新しさは伝わらない — 新しいのは**規律**のほうで、
  「**数式は書く。声は言わない。手順が1つ完成するたびに、声より先に板書が届く**」を
  短く言える場所は200字には無い。ここは How we built it と Accomplishments、
  そして**デモ動画とサムネイル**が担当する(絵で見せれば1秒で済む)。
- **値段は「これは何か」ではなく「なぜ効くか」の話**。ギャラリーに並んだ1段落は
  まず「何であって、他と何が違うか」を answering する欄で、価格から入ると
  **新しいものではなく安い代替品**に見える(HAMM を併願していることとも相性が悪い)。
  所得の話は Inspiration と Peace Prize の応募根拠に置いた(§4・§5)。**そこでは数字を添えられる。**
- ただし `An hour with a human tutor costs more than a month of this.` は、
  審査員の手が止まる一文ではある。**使うなら出典を1つ持つこと**(家庭教師の時給相場は
  地域で開くので、言い切るなら根拠が要る)。

**ストア側の文面は動かさない。** サブタイトル(`Taught on a board, asked again`)と説明文は
Apple に出してあるものが正で、正本は [`store/app_store_listing.md`](store/app_store_listing.md)。
家庭教師の比喩をストアにも広げたくなったら、**審査に出す前に**そちらを直すこと。

### Thumbnail(JPG/PNG/GIF・5MB以下・3:2 推奨)

[`store/devpost/thumbnail-1200x800.png`](store/devpost/thumbnail-1200x800.png)(1200×800 = 3:2・約 260KB)。

```bash
cd apps/mobile
fvm flutter test tool/generate_store_screenshots.dart --plain-name "devpost thumbnail"
```

**画像を手で描き直さないこと。** ストア素材と同じで**絵の正はコード**にしてある
(`tool/generate_store_screenshots.dart` の `_devpostThumbnail`)。地・マーク・
黄マーカーの引き方はフィーチャーグラフィックと共通で、ストアから来た審査員が
同じアプリだと分かるようにしている。

中身と、その理由:

| | |
| --- | --- |
| 左 | アプリ名 + `Taught on a board. / Asked again in 3 days.`(ストアのサブタイトルと同じ言葉)+ `Every tutor teaches. Almost none come back.`(ピッチの後半と同じ言葉) |
| 右 | **本物の授業画面**。板書が積み上がっている途中で下を切ってある |
| 板書 | **英語で描き直したもの**(`_thumbnailShot()`)。審査員は英語で読む |

- **ギャラリーでは幅 350px 前後まで縮む。** 読ませるのは見出しだけで、板書は
  「数式が積まれている絵」として効かせている。文字を足すほど、縮んだときに
  何も読めない板になる。
- 板書は**手順を8つ**積んだ状態にしてある。3つだと板の下半分が空いたまま写り、
  縮めると黒い帯にしか見えない。
- 板書・復習問題の中身は `_lessonState()` / `_practiceQueue()` がロケールから作る。
  **英語側は日本の課程の翻訳ではなく、`packages/curriculum` の intl の topic_id と
  ラベルで作る**([ADR 0005](adr.md#adr-0005))。

## 2. Built with(25タグまで)

入力欄にカンマで続けて打てる。25個ちょうど。

```
flutter, dart, riverpod, go-router, livekit, livekit-agents, webrtc, typescript, node.js, hono, cloudflare-workers, cloudflare-d1, cloudflare-r2, cloudflare-kv, revenuecat, onesignal, claude, deepgram, gemini, silero, katex, zod, sentry, codemagic, github-actions
```

削るときは左から順に落とす(左ほど、無くても構成が伝わる):
`silero` → `go-router` → `katex` → `zod` → `sentry` → `codemagic` → `github-actions`。
**`revenuecat` と `onesignal` は絶対に落とさない**(参加要件と応募カテゴリの根拠そのもの)。

タグと実体の対応(聞かれたときのため):

| タグ | どこ |
| --- | --- |
| `flutter` / `dart` / `riverpod` / `go-router` | `apps/mobile`(iOS先行。状態は Riverpod 3、画面遷移は go_router) |
| `livekit` / `livekit-agents` / `webrtc` | 会話は LiveKit Cloud のルーム、パイプラインは `backend/agent`。板書は Text Streams |
| `typescript` / `node.js` / `hono` | `backend/`・`packages/` を pnpm workspaces で1本に |
| `cloudflare-workers` / `-d1` / `-r2` / `-kv` | API・復習問題(D1)・写真(R2)・無料枠のメータリング(KV)。develop / production の2環境 |
| `revenuecat` | `purchases_flutter` + `purchases_ui_flutter`(ペイウォール・Customer Center)、webhook → D1([`revenuecat.md`](revenuecat.md)) |
| `onesignal` | `/complete` から3日後・7日後を予約。スケジュールは OneSignal 側に持たせ cron を持たない |
| `claude` | 会話と板書の生成(`backend/agent`)、写真の単元判定(`backend/api` の Vision) |
| `deepgram` | 日本語・英語のストリーミングSTT |
| `gemini` | TTS。声は日英で同じ1つ([ADR 0008](adr.md#adr-0008)) |
| `silero` | VAD |
| `katex` / `zod` | 板書LaTeXの検証(agent側でパース)と、`packages/contract` のスキーマ |
| `sentry` / `codemagic` / `github-actions` | 監視と配布(mobile→Codemagic、backend→Actions) |

---

## 3. "Try it out" links

上から順に貼る(**審査員が最初に押すのが App Store** になる並び)。

```
https://apps.apple.com/app/id〔ASC のアプリID〕        ← 公開後に確定。未公開なら貼らない
https://ubiqy.jp/en/
https://github.com/sarushili0430/ai-sensei
```

- **App Store**: 1.0 (50) が 2026-09-10 にリジェクト、51 以降で出し直す([`release.md` §0-1](release.md))。
  **ストアで一般公開済みであることが Shipaton の必須要件**なので、この行が埋まるまで提出は完了しない。
  URL は公開後に App Store Connect の「App Store で表示」から取る。
- **`https://ubiqy.jp/en/`**: 英語の紹介ページ(`apps/lp`)。いまは `noindex` で、
  運営者名・所在地・管轄裁判所などが `fill` のまま。**提出前に埋めて `noindex` を外す**。
- **GitHub**: 初日から public + MIT(Next Gen Award の併願条件)。README が英語でないので、
  審査員向けに**英語の見出しだけでも足すか、この提出文面から辿れる形にする**か決めること。
- Google Play は後追い(掲載テキストとスクショは [`store/play_listing.md`](store/play_listing.md) に用意済み、商品はゼロ)。
  **出せていないうちは貼らない。**

---

## 4. Project details(ストーリー欄・下書き)

Devpost の定型の見出しに合わせた下書き。**事実だけで書く**(数字を盛らない・学習効果を断定しない)。
ラーニングピラミッドは実証性が弱いので**使わない**([`inception-deck.md` §1](inception-deck.md))。

**Challenges の段だけ、畳んだ機能(教え返し・カルテ)に触れている。**
機能の説明としてではなく「締切の前に何を捨てたか」の話として出しているので、ここは意図どおり
(禁止語の趣旨は**いまの製品をそう呼ばないこと**であって、経緯を隠すことではない)。
他の段に書き足すときは、§冒頭の一本道から言葉を借りること。

### Inspiration

```
Photographing a problem to get the answer is a solved problem — every high schooler in Japan already
has an app for it. And yet they still can't solve the same problem on the exam. Reading a worked
solution and feeling "I got it" is not the same state as being able to do it yourself three days
later, and from the inside the two feel identical.

A private tutor does the first half of this well. Almost none do the second: they teach you on
Tuesday, and never find out whether Friday still had it.

So we didn't build another app that hands out answers, and we didn't stop at explaining well either.
We built both halves: a senpai — an older student — who teaches you on a board, and then comes back
three days later to find out whether it stuck.

And it had to fit in a pocket that doesn't have an hourly rate behind it. The students who would
gain most from a tutor are the ones least likely to have one, so the free tier is a real product and
not a teaser: one lesson a day, every day, no account and no email address. A free user who takes
their full daily limit costs us more to serve than a subscriber pays us. For the first year, we
think that's the right way round.
```

### What it does

```
1. Photograph the problem you're stuck on, with your notes if you have them, so your senpai can see
   how far you got.
2. Your senpai teaches it out loud while writing on a shared whiteboard. Equations, calculations and
   figures are written, never spoken — the voice only asks: "Look at D here. It's positive, right?
   So?" You can interrupt and ask back at any time. The lesson ends when you tap "Got it", never
   before.
3. Tapping "Got it" turns that board into exactly one review question. It arrives as a notification
   3 days later, and again after 7. You answer in text; your senpai marks it correct, incorrect, or
   couldn't-read, and anything you got wrong comes back tomorrow.

No scores. We count days in a row and problems solved — no accuracy rate, no ranking, no screen that
compares you with anyone. No account, no sign-in, no email: an anonymous device ID is enough.

Japanese junior-high and high-school mathematics and English, plus the overseas curriculum
(Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics) for English-speaking
learners — the topic tags switch with the language, not just the wording.

Free is one lesson a day, every day, and the review questions it generates. Premium adds several
lessons a day, your review history, and calling your senpai back by voice on something you missed.
```

### How we built it

```
Flutter (iOS first, Riverpod 3) talks to a Cloudflare Workers + Hono API, which opens a LiveKit room
and starts an agent. The agent pipeline is Silero VAD → Deepgram streaming STT → Claude → Gemini TTS,
and it streams a single structured object: {speech, board}. Every time one step of the board is
finished it goes out over LiveKit Text Streams, and only then is the speech spoken — so the board is
never behind the voice, and barge-in still works.

Two guardrails keep the senpai inside the syllabus: the generated topic_id is checked against a
curriculum whitelist server-side and regenerated if it falls outside, and every LaTeX command on the
board is checked against an allowlist and parsed with KaTeX before it is sent, so the app never
receives something it cannot draw.

Photos go to R2, review questions and entitlements to D1, the free-tier meter to KV. RevenueCat
(purchases_flutter + purchases_ui_flutter) runs the paywall and Customer Center, and its webhook
syncs entitlements into D1 — the server is the source of truth for limits, the client entitlement
only decides what to show. OneSignal holds the 3-day and 7-day schedules, so there is no cron
anywhere in the system.

The whole thing is a public pnpm + Flutter monorepo under MIT from day one: schemas and fixtures in
packages/contract are validated by both the Dart app and the TypeScript server, so the two can't
drift apart silently.
```

### Challenges we ran into

```
Spoken equations don't work. "X squared minus three X plus two" does not survive the trip into
anyone's head, so the senpai had to be split in two — a voice that only asks, and a board that does
all the writing. That one decision drove the streaming protocol, the LaTeX guardrail and the layout.

Our first TTS vendor could not read Japanese mathematics aloud at all, which sent us looking for a
voice that handles both languages; we ended up with one Gemini voice used for Japanese and English
alike, so the senpai doesn't change character when the language does.

The hardest cut was a feature: the original pitch had the student teach the lesson back and kept a
chart of where they stumbled. It demoed well and it made the loop too long to finish on a phone
before bed. We folded it into one review question and wrote down why (ADR 0009), because a hackathon
deadline makes it very tempting to keep a feature that photographs well.

And Apple rejected 1.0: the permission dialogs were in Japanese inside an English build. The fix was
small; the lesson was that anything shown by the OS has to be localized where the OS looks for it,
so we added a CI check that inspects the built .app.
```

### Accomplishments that we're proud of

```
The board. A whiteboard that fills up while someone explains to you, that doesn't erase the previous
step, and that never reads a formula out loud. Each step is sent the moment it is finished, so the
writing is never behind the voice — that is the whole trick, and it is the part we would have cut
first under time pressure. It's also the part that makes the app feel like a person rather than a
search box.

And the things we refused to ship: no score, no accuracy rate, no streak-shaming notification. A
wrong answer changes nothing except when the question comes back.
```

### What we learned

```
Write down what you are not building before you need the discipline. Our "not doing" list is the
reason we shipped a whole loop instead of most of a bigger one.

Also: build the paywall and the notifications early. Both look like end-of-project work, and both
turned out to need decisions — what a subscription unlocks, when the senpai is allowed to reach out —
that belong to the product, not the plumbing.
```

### What's next for Katarute

```
Android (the listing is written and the app is the same Flutter codebase), Sign in with Apple so
progress survives a new phone, a text lane for people who can't speak out loud, and more of the
curriculum.
```

---

## 5. Additional info / 併願するカテゴリ

[`inception-deck.md` §1](inception-deck.md) で決めた併願先と、**応募根拠**。
カテゴリごとに**何を出さないといけないか**は §0-4(一次情報を当たったもの)。
根拠が1行で言えないカテゴリには出さない。

| カテゴリ | 根拠 |
| --- | --- |
| Next Gen Award | 初日から public + MIT のモノレポ |
| OneSignal "Keep Them Coming Back" | `/complete` から3日後・7日後を予約。間隔反復そのものが再訪導線 |
| Peace Prize | 点数・順位・煽りを持たない設計(4つの約束の2〜4番目)。**無料のまま毎日1回**なので、家庭教師の時給が最初の関門になっている側にも同じ授業が届く(上限まで使う無料利用の原価は月 ¥3,800 で、課金1人分の手取りより高い。[`business/pricing_v1.md`](business/pricing_v1.md)) |
| HAMM | 週980 / 月2,980 / 年29,800([`business/pricing_v1.md`](business/pricing_v1.md))と初回授業直後のペイウォール |
| #BuildInPublic | 同上(public リポジトリ・ADR を含む設計資料が全部見える) |
| Design | 板書・スクショ・LP まで**生成がコード**([`design_direction_v0.html`](design_direction_v0.html)) |

そのほか、提出物として先に作っておくもの:

- **デモ動画(2分)** — 撮る順は ①撮影 → ②板書つき授業 → ③「わかった」→ ④3日後の通知 → ⑤採点。
  ストアのスクショの並びと同じにする。
- **全機能を開けるプロモコード** — App Store Connect で発行し、Devpost の審査員向け欄に書く。
  RevenueCat の entitlement ではなく**ストアのコード**で配る(コードで買った扱いになるので導線が本番と同じになる)。

---

## 6. 提出前チェックリスト

要件の出どころは §0。**上から順に、下ほど締切に近づいても間に合う。**

### 落ちる条件(これが欠けると提出そのものが無効)

- [ ] **App Store で一般公開されている。**「審査中」は失格。51以降のビルドで出し直し → 審査通過 → URL 確定
      ([`release.md` §0-1](release.md))。**9/23 までに公開**が目安(締切の1週間前)
- [ ] **米国から見える**こと(配信地域に米国を含める。[`store/app_store_listing.md`](store/app_store_listing.md) §1)
- [ ] 審査員が有料機能を開けること — **プロモコードを App Store Connect で発行**して Additional info に書く
      (無料トライアルを付けていないので、コードが要る)
- [ ] デモ動画を YouTube か Vimeo に上げる。**2分未満**・実機で動いているところ・**限定公開は可、非公開は不可**
      (撮る順は §5)
- [ ] 画像ギャラリーに **1024×1024 のアイコン**(`AppIcon.appiconset/Icon-App-1024x1024@1x.png`)と
      **1179×2556 のスクショ**([`store/screenshots/en/plain/`](store/screenshots))を上げる。どちらも手元にある
      (スクショは**中身まで英語**になっていること。2026-09-11 に直した)

### 文面と素材

- [x] Thumbnail(3:2)を `generate_store_screenshots.dart` から描き出す(`store/devpost/thumbnail-1200x800.png`)
- [ ] Project name / Elevator pitch / Built with / links を貼る(§1〜§3)
- [ ] Project details を貼る(§4)。**貼ったあと、禁止語が混ざっていないか読み返す**
- [ ] `https://ubiqy.jp/en/` の `fill` を埋め、`noindex` を外す

### 併願するカテゴリごと(§0-4)

- [ ] **OneSignal**: App ID を書く + 「campaign を1つ作って配信した」と言える状態にする。
      いまは `/complete` から REST で個別に予約しているだけなので、**要件を満たしているか要確認**
- [ ] **Peace Prize / HAMM / Design**: 説明を Additional info に書く(§5 の根拠がそのまま使える)
- [ ] **Next Gen**(出すなら): 学籍メール + **英語のセットアップ手順**(README が日本語)
- [ ] **#BuildInPublic**(出すなら): 公開の投稿へのリンク。**リポジトリが public なだけでは足りない見込み**

- [ ] 提出(**2026-09-30 23:45 PDT**)
