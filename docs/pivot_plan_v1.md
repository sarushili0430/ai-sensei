# Pivot Plan v1 — toward "the private-tutor AI (Senpai)"

Written: 2026-08-09 / Target: App Store binary submission 2026-09-05 → Shipaton submission 2026-09-30
Primary sources: [`inception-deck.md`](inception-deck.md), [`business/business_direction_v0.md`](business/business_direction_v0.md)

This document records the decision to **replace the whole submission with a private-tutor AI**, plus the
design and plan that follow from it. It **partially amends the first of the four promises** in
[`inception-deck.md`](inception-deck.md) §0, so ship it together with the PR that rewrites the deck (§9).

---

## 0. Decisions (2026-08-09)

| # | Decision |
| --- | --- |
| 1 | **Replace the whole submission with a private-tutor AI** (stop defending the current scope) |
| 2 | **Build a board layer** (LaTeX + a few figure primitives). Voice alone cannot teach math |
| 3 | **Recast the character as a "senpai"** (was a kouhai) |
| 4 | **Send the problem and the notebook together** (grounding) |
| 5 | **One session = one question, 15–20 min** |
| 6 | **The parent pays.** ¥5,000/month as a placeholder (fixed after measurement, §6) |
| 7 | **Add study planning** (needed as an explanation to parents — but built by voice, not a form) |
| 8 | ~~**Do the co-presence (study room) mode**, at zero marginal cost~~ → **withdrawn 2026-08-11** ([ADR 0006](adr.md#adr-0006)). Folded because it spent attention, not cost. The board moved to the karte |

### Partial constitutional amendment

Of the four promises in deck §0, **only the first is amended**. The other three are untouched.

| # | Promise | After |
| --- | --- | --- |
| 1 | ~~Never give the answer~~ | **Teach. Then have them teach it back** |
| 2 | No scores | Kept (most easily broken in the parent report, §5-2) |
| 3 | Passing is never shameful | Kept |
| 4 | No nagging | Kept (the cap ships as "the senpai's judgement", §6-3) |

The new one-liner:

> **We give you the answer. Then you teach it back to us.**
> The AI tutor that teaches you — then asks you to teach it back.

The name "Katarute" (*kataru* × *karte*) **survives**: the user is the one teaching back, so the user is
still the one talking.

---

## 1. Why this shape — it solves four problems at once

Why the loop is "teach → have them teach it back on the spot" rather than "teach and stop".

1. **The misreading insurance survives.** If the AI misreads the problem, the user's explanation breaks
   down and the misreading surfaces. It is the only remedy for
   [`business_direction_v0.md` §3-3](business/business_direction_v0.md) — "the more the app is built on the
   AI understanding things, the more fatal a misreading is"
2. **Cost closes structurally.** The AI only speaks during the "teach" span; the user speaks for the rest,
   so the TTS-dominated term does not run away
3. **The OneSignal prize ($25k, our best shot) survives.** Places where the explanation stalls still land in
   the karte as **observed fact**, so the 1/3/7-day revisit still works. "Note what they asked about" would
   only capture known-unknowns and would degrade the karte
4. **Almost every existing asset stays.** New development narrows to the board layer alone (inventory in §8)

### Options we rejected, and why

| Option | Why rejected |
| --- | --- |
| Teach and stop (no teach-back) | Misreadings become fatal. Cost never closes. The karte loses its evidence |
| Define a gap as "what they asked about" | Only captures known-unknowns. Contradicts `business_direction_v0.md §3-3`: "the gaps you think you understand sit where you don't suspect anything" |
| Have the AI grade the quiz | Kills promise 2, and **reinforces the AI's misreading three times over 1/3/7 days** (the worst failure mode) |
| Co-presence with the mic always open | STT/VAD bill for the whole time in the room. A different cost structure → replaced by the zero-cost build in §4-2 |
| A hard cap (N per day) | Breeds resentment. The rejection in `business_direction_v0.md §3-3` still holds → replaced by "the senpai calls it a day" in §6-3 |
| Build the study plan from a form | Maximum friction before any value is felt; first-run drop-off → replaced by voice input in §4-3 |

---

## 2. The core loop

```
photograph the problem + the notebook
  ↓
the senpai teaches, with a board          ← new: the board layer (§3)
  ↓
"okay, explain that back to me"           ← existing: the conversation pipeline
  ↓
where they stall becomes a gap in the karte  ← existing: karte generation
  ↓
revisit via a quiz after 1/3/7 days       ← existing: OneSignal + new question generation
  ├ said it     → the gap closes. Done in 10s (no need to speak aloud)
  └ stalled     → call the senpai back right there → lesson mode
```

The point is to make **the quiz the entrance and the explanation the body**. It normally finishes as 10
seconds of text, which directly answers the open concern in deck §7-5 ("high schoolers can't speak aloud —
trains, living rooms, late at night").

### Quiz design constraints (important)

| Rule | Why |
| --- | --- |
| **Questions come from what the user explained, never from what the AI taught** | So spaced repetition never reinforces the AI's misreading |
| **Self-reported, not AI-graded** (said it / didn't) | Keeps promise 2, "no scores". The judge is the student |
| One question, text, 10 seconds | Zero friction. Revisit rate is the real metric |

---

## 3. The board layer (the biggest new build, and the biggest risk)

### 3-1. Design principle — this is a cost pillar, not a cosmetic feature

> **Formulas, arithmetic and figures go on the board. Voice carries only the question and the connective tissue.**

A real tutor is not talking while they write. This principle makes experience and cost the same move (the
same structure as [`business_direction_v0.md` §3-3](business/business_direction_v0.md)).

```
❌ voice only  "x squared minus three x plus two equals zero, so the discriminant D
                is nine minus eight, one, which is positive, therefore…"  (60 chars)

✅ with board  board: x² − 3x + 2 = 0  →  D = 9 − 8 = 1 > 0
                voice: "look at D here — it's positive, right? So?"  (25 chars)
```

TTS character count halves, and it is easier to follow. **Any implementation that breaks this principle is
rejected.**

### 3-2. Sync model — per step (no millisecond sync)

Conversation gets its low latency by streaming tokens into TTS as they arrive; the board needs structure.
We resolve the conflict by **dropping the sync granularity to one step**.

```
the LLM streams an array of {speech, board} as streaming JSON
  ↓ each time the agent completes one step
send board over the LiveKit data channel → then speech to TTS
  ↓
the frontend stacks one line per arrival (earlier lines are never erased)
```

| Option | Verdict |
| --- | --- |
| **A. Per-step sync** | **Adopted.** Interruptible, latency-tolerant, realistic to build |
| B. Generate everything, then play | Rejected. It stops being a conversation (no interruption, long wait) |
| C. Word-level sync via TTS word timestamps | Rejected. Would kill us inside four weeks |

**Remaining problem**: a few seconds of silence before the first step arrives.
→ Fill it with a **pre-generated audio asset** ("right, let's take a look together") — same idea as the
pre-rendered backchannels in §3-3, with zero TTS calls.

### 3-3. Contract schema (lives in `packages/contract`)

```ts
// packages/contract/src/board.ts (new)
export type BoardStep = {
  index: number;
  /** The sentence to speak. Questions and connectives only — never read a formula aloud (§3-1) */
  speech: string;
  /** The element to stack on the board. null means voice only (backchannel, confirmation) */
  board: BoardElement | null;
};

export type BoardElement =
  | { kind: "latex"; tex: string }
  | { kind: "text"; body: string }
  | { kind: "plot"; fn: string; domain: [number, number]; marks?: PlotMark[] }
  | { kind: "triangle"; vertices: [Pt, Pt, Pt]; labels?: string[]; marks?: AngleMark[] }
  | { kind: "circle"; center: Pt; r: number; labels?: string[] };
```

- Figures are **fixed to three or four primitives**; the LLM emits parameters only (no free drawing)
- LaTeX rendering is `flutter_math_fork` on the Flutter side
- Sent over the LiveKit data channel. It lives in `packages/contract` so **mobile and the agent validate the
  same shape** (the same policy as the existing `api.ts` / `karte.ts`)

### 3-4. The gate at the end of W1 (8/16)

> **Can you learn one problem with the board and reach "I get it"?**

**Decide the fallback in advance** (don't defer the call). Note that there are **two fallbacks, and they are
different things**.

| Failure mode | Fallback |
| --- | --- |
| **Generation quality** is missing (the LLM's board is hard to follow) | Stop letting the LLM board freely; **make it follow a solution-step template**. A few templates per unit ("solve the equation", "graph it and read off the intersection", "split into cases") |
| **Rendering** breaks (LaTeX won't display, or displays wrong) | Templating **does not help here**. Constrain from the schema side via the allow-list check in §3-6 |

### 3-5. Flutter implementation plan (settled by the 2026-08-09 investigation)

Confirmed by reading the actual sources of `livekit_client 2.10.0` / Flutter 3.44.8.

| Question | Decision | Evidence |
| --- | --- | --- |
| **Receive path** | **Text Streams API** (`registerTextStreamHandler` + a dedicated topic). Never raw `publishData` | `stream_writer.dart` always pins `Reliability.reliable` internally, whereas `publishData` defaults `reliable` to **false (LOSSY)** — forget it once and you get loss and reordering. **Pick the path that has no mine to step on** |
| **Ordering** | The reliable path handles it | In `engine.dart` the sender attaches a monotonic `sequence`, the receiver dedupes, and on reconnect everything after `lastMessageSeq` is resent |
| **Unit of receipt** | **One step = one stream**, awaited to completion with `readAll()` | No need to hand-assemble partial JSON across chunk boundaries. The envelope carries an index, so the receiver can still detect loss |
| **readAll() completion order (found in implementation, 2026-08-10)** | The receiver **serializes** `readAll()` onto a single Future chain (`_boardQueue` in `session_controller.dart`) | Handlers fire in envelope arrival order, but `readAll()` does not necessarily *complete* in that order (envelopes with fewer chunks finish sooner). When one overtakes another, the receiver's `seq` check **misreads it as loss** — the board breaks up even though everything arrived. **A heavy trap**: whether overtaking happens depends on per-envelope chunk count (i.e. the length of `tex` / `speech`) and the connection, so **the same problem can teach fine one time and break the next**. And the symptom is "the board broke up" — delivery was fine; the loss detector is the thing crying wolf. Re-implement this without knowing it and you lose days to triage |
| **LaTeX rendering** | `flutter_math_fork` 0.7.4 (**risky, §3-6**) | Compatible with Flutter 3.44.8. Everything high-school math needs (fractions, radicals, exponents, subscripts, sums, integrals, matrices, `cases`) is absent from the unsupported list |
| **Figure rendering** | **Hand-write a `CustomPainter`** (`fl_chart` rejected) | `fl_chart` has no type for triangles or angle marks. The existing `common_widgets/marker_text.dart` already establishes "a `CustomPainter` driven by a progress value", which **matches the board's stack-one-line-and-keep-it requirement**. `AppDurations.draw = 420ms` is reusable too |
| **golden test** | A unit golden per element, plus one shot of "three steps stacked" | Rides the existing `reduceMotion` practice (`test/support/harness.dart`) that pins animations to their end state. We verify the final state, not the timing |

**Side benefit**: the board picks up the same stroke as the existing highlighter treatment. The karte's
yellow/pink marker and the board's pen tip share one motion language — good for the Design Award too.

### 3-6. LaTeX validation (`packages/guardrail`) — three layers

`flutter_math_fork`'s **last release was 2025-05-21 (~15 months ago), with 43 open issues**, and upstream
`flutter_math` is unmaintained. Putting that on a four-week critical path demands a layer that guarantees
**nothing unrenderable is ever sent**.

**The 2026-08-09 measurement spike passed on rendering itself.** ~30 formulas (textbook notation
`{}_n\mathrm{P}_r` / `{}_n\mathrm{C}_r`, the binomial theorem, `pmatrix`, `cases`, `\overrightarrow`,
`\lim`, definite integrals, polar form) were rendered to PNG and inspected: **zero broken**. No dependency
conflicts either (nine packages such as `flutter_svg` / `provider` come in transitively, nothing more).

Validation splits into three layers, because **each catches a different way of breaking**.

| Layer | Where | What it prevents |
| --- | --- | --- |
| **① Formula templates** | Prompt (generation side) | Layer ② can't guarantee the **correct combination** of allowed commands (wrong arity in `\frac{\frac{}{}}{}{}` and friends). Fix the constant parts and let the model fill in variables, for the common formulas |
| **② Command whitelist** | `packages/guardrail` (pure functions) | Rejects commands **the port doesn't support**. Only what was verified by looking at rendered PNGs is allowed (below). Also incidentally drops `\href`, `\includegraphics`, etc. |
| **③ Real parse in KaTeX** | `backend/agent` (before sending) | Rejects **broken syntax** (unclosed braces, wrong arity). `flutter_math_fork` is a Dart port of KaTeX, so parsing with real KaTeX on the Node side catches syntax errors up front. Note: passing KaTeX does not imply the port supports it, so ② is still mandatory |

Rejects are **regenerated** on the agent side (the same double-guard stance as the `topic_id` whitelist
check, deck §6).

**Layer ②'s measured whitelist (first edition)**:

```
operators/relations  + - \cdot = < > \leq \geq \neq \pm !
fractions/radicals   \frac \cfrac \sqrt \sqrt[]
sub/superscripts     ^{} _{}   (including left-shoulder subscripts, {}_{n}\mathrm{P}_{r})
brackets             ( ) [ ] \{ \} | |
functions            \sin \cos \tan \log_{}
sums/limits          \sum_{}^{} \lim_{} \to \int_{}^{} \,
vectors              \vec{} \overrightarrow{}
logic                \therefore \because      ← added 2026-08-09 (∴ ∵ both render correctly)
environments         \begin{pmatrix} \begin{cases}
type styles          \mathrm{}        ← required for textbook-notation P and C
Greek                \theta \alpha \beta \pi
```

**Forbidden (established by measurement)**: Japanese inside `\text{}` renders as tofu (§3-6d).

Unverified (measure in W2): `\ln`, matrices 3×3 and larger, `cases` with 3+ rows, `\overline{}`, dark mode,
jank on a real device.

`packages/contract` is a dependency-free layer, so it carries only the ceiling (character count);
**command-level checking lives in guardrail** (the same split as `topicIdSchema` in `karte.ts`).

### 3-6b. Long formulas overflow the screen width (settled by measurement, 2026-08-09)

In the spike, the addition formulas **overflowed an 800px-wide canvas**. The spike wrote that off as "a flaw
in the test harness's fixed width", which is **wrong**.

- The iPhone 15's logical width is **393pt**. Minus the board's padding, the effective width is about **340pt**
- So the canvas that overflowed is **more than twice as wide as a real device**
- And the addition formulas are not a long formula by high-school standards
  (the quadratic formula, change of base, the binomial theorem, and factoring intermediates are all longer)

**"Long formulas overflow" is the board's normal state, not an edge case** — a design task for the board
layer that is independent of what `flutter_math_fork` can render.

**Measured (effective width 340pt = the iPhone 15's 393pt minus estimated board padding)**:
**4 of the 10** formulas prepared actually overflowed.

| Formula | Measured width | |
| --- | --- | --- |
| Cubic factoring `x^3-6x^2+11x-6=(x-1)(x-2)(x-3)` | **449.6pt** | overflows (worst) |
| Addition formulas | **380.9pt** | overflows |
| Expansion intermediate | **373.0pt** | overflows |
| Definite-integral intermediate | **351.8pt** | overflows |
| Binomial theorem / quadratic formula / change of base / simultaneous equations | 148–270pt | fits |

**Decision: C (split) is the primary, A (shrink) is the insurance, used together.**

| Option | Verdict from measurement |
| --- | --- |
| **C. Split the formula across steps** | **Primary.** Breaking either side of `=` onto two lines fits comfortably **without shrinking**. It matches how textbooks and blackboards write, so it reads naturally. Splitting becomes the **LLM's responsibility**, so it lands in the prompt |
| **A. Auto-shrink with `FittedBox`** | **Valid as insurance, but it has a floor.** All four overflowing formulas stayed readable at 54–97%. But squeezing a 600pt-natural-width formula (a quartic expansion) into 340pt gives 54% = an effective 13pt, "just barely"; a 200pt box (32%) is "hard"; a 150pt box (24%) is **illegible**. → Bake in a threshold: **any step below 70% gets re-split on the agent side** |
| B. Horizontal scroll | **Rejected (and measurement backs it).** It cuts off abruptly, as in `= (x - 1)(x -`, and **a still image gives no hint that anything follows**. It invites "that's all of it". Head-on contradiction with what the board is for (it's all there even if you weren't listening, and when you look back later) |

**When it does drop below 70%** (i.e. agent-side splitting isn't working — a state that shouldn't happen):
stop shrinking (measurement says 32% is "hard" and 24% is "illegible") and **fall back to horizontal
scroll** — but **always show a fade cue at the right edge**, since a scroll with no cue reproduces exactly
the reason option B was rejected ("that's all of it").

> **W2 homework**: there is no way to observe this state in production today (only `debugPrint`). Without
> sending it to Sentry, **we will never learn that agent-side splitting stopped working.**

**Consequences for the contract**: `board.ts` constrains `tex` with `maxLength: 200` (**characters**), but
**display width is not a function of character count**. The measurements show it:

| Formula | Characters | Measured width |
| --- | --- | --- |
| Change of base (nested `\frac` = grows vertically) | 39 | **148.0pt** |
| Cubic factoring (one horizontal line) | **38** (near-identical) | **449.6pt** |

**Near-identical character counts, 3× the display width.** So `maxLength` works as a **safety valve against
runaway input**, but **not as a guarantee of display width**.

- **Short term (W1)**: the contract carries structural constraints only (single line, no multi-line
  environments, a character ceiling as a safety valve), and **display width is guaranteed by mobile-side
  rendering (A + C)**. The contract can stay as it is
- **Medium term (candidate for W2+)**: extend layer ③ (KaTeX on Node) to **estimate render width from font
  metrics**, and **split any over-width step into two on the agent side before sending**. Then we can
  constrain by "width actually consumed" rather than character count

### 3-6d. [Trap] Japanese inside `\text{}` renders as tofu

Rendering `\text{よって}\ x=2` turns **"よって" into black bars (tofu)** (confirmed in PNG), because KaTeX's
font (`KaTeX_Main`) has no Japanese glyphs. Japanese labels elsewhere on the same screen render fine, so
**it is confined to the formula block**.

**Reject it explicitly, because it's the way the LLM most wants to write.** But this is not "forbidden" so
much as **"wrong place"** — the contract already has the right one: `{ kind: "text", body }` in `board.ts`
is where a line of Japanese goes. So the guardrail's regeneration instruction should say **"send Japanese as
a `text` element"**, not "don't put Japanese in formulas".

Note: a real device could in principle fall back to a system Japanese font (the test environment has none),
but **even if it did there is no reason to put Japanese in a formula block**, so the ban stands.

`\therefore` (∴) and `\because` (∵) were confirmed to **render correctly** and have been added to the
allow-list.

### 3-6c. [Trap] Font loading in golden tests

`loadAppFonts()` in `test/support/harness.dart` **strips** the `packages/xxx/` prefix from the family names
in `FontManifest.json` before registering them (correct for the app's own `ZenMaruGothic`, which has no
prefix). But `flutter_math_fork` refers to its own fonts by the **prefixed** name
`'packages/flutter_math_fork/KaTeX_Main'`.

Reuse it as-is and formulas render as **black squares (tofu)** in widget tests. Capture that as a golden
without noticing and you get a golden test that **passes while the real thing is mojibake** — one with no
detection power at all.

**When implementing the board goldens for real, either fix `loadAppFonts()` to preserve prefixes, or provide
a board-specific font loader.**

### 3-7. Fix alongside

- `livekit_client: ^2.3.5` in `apps/mobile/pubspec.yaml` actually resolves to **2.10.0**. This design assumes
  the 2.10.0 API, so **raise the declaration to `^2.10.0`** (so regenerating the lockfile can't silently
  resolve back to the old API)

---

## 4. Mode design

### 4-1. Lesson mode (paid, incurs marginal cost)

- Roughly 15–20 min per question. Starts from photos of the problem + the notebook
- Teach with the board → have them teach it back → generate the karte → generate the quiz
- **Don't require two photos.** Keep it a hint: "the senpai won't get lost if the problem is in the shot too"
  (one photo often contains both)
- The problem photo is **a textbook or workbook page = copyrighted material**. We send it for analysis, but
  **whether we keep it in R2 is a separate decision** (discarding after analysis is defensible in future
  publisher negotiations — [`business_direction_v0.md` §6](business/business_direction_v0.md))

### 4-2. Study-room mode — **withdrawn** (2026-08-11)

**Built, then folded.** [ADR 0006](adr.md#adr-0006) is authoritative.

The zero-cost design goal was met (no STT / TTS / LLM / LiveKit started at all; the only traffic was a
single D1 write on leaving). It was folded not over cost but because it **connected to no part of the core
loop**:

- The only way forward from the study room was "senpai, got a minute?" = taking a photo, i.e. **the same
  destination as home**. It spent a permanent tab duplicating an entrance we already had
- Time spent couldn't be shown to the student under promise 2 (no scores), and appeared in neither
  `/v1/me/progress` nor the parent report. We kept a permanent tab and a D1 table for **a number that never
  once reached the student's screen**
- Home's primary action split in two, and on days the senpai had wrapped up we made colour tell you which
  one was pressable. On those days the right destination is **review**, which is inside the core loop

The one part with real substance — **the board from the last lesson is still there** — moved to the karte's
"what the senpai wrote" section. Boards still outlive the lesson and stay readable.

### 4-3. Planning mode (paid, built by voice)

**Zero form input.** Reuse of the existing voice pipeline only.

```
senpai "when's the test?"          → "September 10th"
senpai "what's the scope?"         → "Math II trig, textbook pp. 120–150"
senpai "any workbooks you use?"    → "4STEP and the Blue Chart"
senpai "how about something like this?" → the plan appears on screen
```

- When it falls apart, rebuild it by voice: "I was sick, lost three days" → "let's redo it then"
- The differentiation from form-based tools like Studyplus falls out for free
- If we run late, degrade to **the senpai just proposing a fixed template** (drop order ① in §7)

---

## 5. The parent pays — the discoverer and the payer are different people

### 5-1. The real paywall is "make it easy to ask your parent"

The high schooler finds it on the store. **The parent never looks at the store and never opens the app.**
Only one funnel works.

```
student uses it → likes it → asks a parent → parent approves (Family Sharing "Ask to Buy")
                              ↑ this is the part we build
```

- Export the karte as "this month's report" and **let them send it to a parent over LINE or email**
- That report naturally carries "continuing costs ¥5,000/month"
- The parent sees, for the first time, **something a graded paper can never show**: how their child
  understands math

**Building a shareable report converts better than polishing a paywall screen.** Raise its priority.

### 5-2. What may and may not go in the parent report (the defensive line for promise 2)

The parent report is where promise 2, "no scores", is most likely to break. Draw the line first.

| ✅ Include | ❌ Exclude |
| --- | --- |
| Number of gaps closed | Accuracy rate |
| Day streak | Deviation scores, comprehension scores |
| Names of units they can now explain | Study-time rankings |
| **A quote of the student's own explanation** ("the discriminant is the thing that tells you how many solutions there are") | Comparison against other users |

**The quote is the strongest item.** It lands harder than a number, and no other study app can produce it.

---

## 6. Price and cost

### 6-1. Measured cost (assuming an 18-minute session)

| Item | Assumption | Without board | **With board (§3-1)** |
| --- | --- | --- | --- |
| TTS | AI speech × 330 Japanese chars/min | ¥54–108 | **¥25–50** |
| STT | mic-open time × ¥1.2–2/min | ¥24–40 | **¥8–14** (VAD gate) |
| LLM | 15–20 turns + structured board output | ¥30–60 | ¥30–60 |
| Vision | 2 images, problem + notebook | ¥10–15 | ¥10–15 |
| Karte + quiz generation | On finish | ¥10–15 | ¥10–15 |
| LiveKit | Connected minutes | ¥5–10 | ¥5–10 |
| **Total** | | **¥135–250** | **¥70–120** |

**All of this is on paper. Replace it with W3 telemetry before fixing the price**
(the homework in [`business_direction_v0.md` §3-3](business/business_direction_v0.md)).

**STT gating**: while the AI is speaking, don't run full STT — run VAD only and open STT on speech onset.

### 6-2. Price

| Plan | Price | Role |
| --- | --- | --- |
| Weekly | ¥1,200–1,500 | **The main entrance.** Pre-test spike shape. The September midterms give us conversion data |
| Monthly | ¥5,000 | The real one. Explained to parents relative to cram school (¥30,000/month) |
| Yearly | ¥40,000 | For parents of exam-year students |

- Net of Apple's 15% cut: ¥4,250. Once a day (30/month) costs ¥2,100–3,600 → **gross margin ¥650–2,150**
- **Without the board-first principle (§3-1), even ¥5,000/month loses money.** Raising the price is not a
  substitute for it
- Twice a day (60/month) is loss-making even with the board → the cap in §6-3 is required

**On anchoring**: "cram school ¥30,000/month vs ¥5,000" is the comparison *we* want to make. What a high
schooler actually puts next to us is **the free AI in their hand**. Treat ¥5,000 as **a quality bar we set
ourselves**: the first session has to make it obvious this is not that.

### 6-3. Free tier and cap

| | Contents | Cost |
| --- | --- | --- |
| **Free** | Karte, quiz, review, 1/3/7-day notifications + the first one or two lesson-mode sessions | Near zero |
| **Paid** | Lesson mode, planning mode, parent report | Metered |

**Only the things that cost money are paid**, so the explanation fits in one line (submittable as-is for the
HAMM prize).

Don't surface the cap **as a quota**. Implement it as the senpai's personality.

```
❌ "Sessions left today: 0/3"        ← resentment starts the moment a number appears
✅ "Let's stop here for today.        ← a teacher's judgement, not a limit
     Cramming more won't stick.
     We'll pick it up tomorrow"
```

- Set the value so normal use (1–2 per day) **never triggers it**
- No numbers in the UI at all. **Fair use lives only in the terms of service**
  (the "fair-use cap we don't surface" in
  [`business_direction_v0.md` §3-3](business/business_direction_v0.md))
- Implemented by extending `checkSessionAllowance` in `backend/api/src/lib/entitlement.ts`

---

## 7. Schedule (4 weeks)

**The real deadline is the 9/5 (Fri) binary submission, not 9/30.** Shipaton requires the app to be
**publicly released** on the store, and we need buffer for 48h review plus one rejection (deck §7-2, "a first
submission in mid-September is dangerous").

**The constraints are not engineering hours but ① iteration count ② App Review latency ③ decision
bandwidth.** AI compresses lines of code; it does not compress those three.

### W1 (8/10–8/16) — the board layer and the constitutional amendment

Put the biggest risk first.

- [ ] Board-layer spike: streaming JSON of `{speech, board}` → send per step over the data channel
- [ ] LaTeX rendering (`flutter_math_fork`) + 3–4 figure primitives
- [ ] Implement "formulas on the board, voice only for questions" in the prompt
- [ ] Pre-rendered opening audio asset (fills the silence)
- [ ] Rewrite the senpai persona prompt (ja); re-pick the ElevenLabs voice
- [ ] Amendment PR for the inception deck (§0)

> **8/16 gate: can you learn one problem with the board and reach "I get it"?**
> If not, switch immediately to the §3-4 fallback (solution-step templates).

### W2 (8/17–8/23) — close one full loop

- [ ] "Okay, explain that back to me" → karte → quiz generation (honouring the §2 constraints)
- [ ] Rebuild the 1/3/7-day notifications around the quiz (self-reported, never AI-graded)
- [x] ~~**Study-room mode** (zero cost) + pre-rendered voice prompts~~ → withdrawn after implementation ([ADR 0006](adr.md#adr-0006))
- [ ] Change the billing frame (¥1,200/wk, ¥5,000/mo, ¥40,000/yr) and redefine the free tier (`entitlement.ts`)
- [ ] Implicit cap via "the senpai calls it a day" + fair use in the terms of service

### W3 (8/24–8/30) — parents, and English

- [ ] **Parent report + sharing funnel** (§5-1 — this *is* the paywall)
- [ ] **Voice-built study plan** (§4-3; the degraded version is fine)
- [ ] English locale (senpai prompt en, few-shots, UI copy)
- [ ] **Per-session cost telemetry** (§6-1 — don't fix the price without measurement)

### W4 (8/31–9/4) — the deliverables

- [ ] Reshoot every store asset (icon, 5 screenshots, description, keywords)
- [ ] Review notes (explaining AI-generated content and the guardrails)
- [ ] Rewrite the README, the inception deck, and the one-liner (English is authoritative)
- [ ] **9/5 binary submission**

### W5–W8 (9/6–9/30)

Release → acquire real users → **collect billing data on the September midterm spike** → 2-minute demo video
→ early submission on 9/25.

### Drop order if we run late (decided in advance)

1. Study-plan automation → degrade to the senpai proposing a fixed template
2. External sharing of the parent report → in-app display only (they screenshot it)
3. English locale on the main screens only (subtitles cover the rest in the video)

**The board layer and one full "teach → teach it back" loop are never dropped.** They are the product.

### H0 (dogfooding)

Once the W1 spike passes, **run it on myself for a week first**
(H0 in [`business_direction_v0.md` §3-3](business/business_direction_v0.md)).
Do one full "learn with the board, teach it back, get a quiz three days later" loop myself before fixing the
price.

---

## 8. Asset inventory

| Keep | Rewrite | Drop |
| --- | --- | --- |
| LiveKit conversation pipeline | `prompts/kohai_conversation.{ja,en}.md` → senpai version | Kouhai character visuals and expression variants |
| Karte generation, gap extraction | `prompts/question_types.few_shot.{ja,en}.md` | — |
| OneSignal 1/3/7 days | `prompts/karte_generation.{ja,en}.md` (add quiz generation) | — |
| RevenueCat (a consumable slot already exists) | `backend/api/src/lib/entitlement.ts` (redefine the free tier) | Old prices |
| D1 / R2 schema, `packages/contract` | Add `board.ts` to `packages/contract` | — |
| Capture flow | Support two images, problem + notebook | — |
| Celebration, day streak, "gaps closed" counter | The four onboarding screens | The entire old store asset set |
| `packages/curriculum` | Repurpose topic_id matching into a "is this in scope to teach" check | Its use as a guardrail for "never give the answer" |
| The app name "Katarute" | — | — |

---

## 9. Restacking the prizes

| Prize | Current basis | After the pivot |
| --- | --- | --- |
| **Peace Prize** $15k | "In an era where answer-giving AI robs people of thinking, an app that makes you explain" | The story inverts and disappears. **Replaced by "a private tutor for kids who can reach neither a cram school nor a tutor" = educational access inequality**, which is stronger — but it must not contradict the pricing (§6) |
| **OneSignal** $25k | Spaced repetition is the product itself | **Holds.** Even quiz-first, it isn't bolted on as long as the questions come from what the student explained (§2) |
| **Design Award** $15k | Character staging | **Improves.** The board layer (in lesson mode, and left behind in the karte) photographs and films best |
| **HAMM** $15k | Paywall design | **Improves.** "Only the things that cost money are paid" + the implicit cap (§6-3) |
| Next Gen / #BuildInPublic | Student + public repo | Unaffected |

---

## 10. Remaining risks and open questions

1. **The 8/16 board gate.** The biggest one. Do not wave it through (same rut as deck §7-1)
2. **¥5,000/month is a placeholder.** Fix it after the W3 telemetry. A big drop creates room to lower the
   price, which serves the struggling-student mission directly
3. **"Struggling student" is still vaguely defined.** (a) no money at home, (b) rural, no cram school nearby,
   (c) parents don't invest in education — ¥5,000/month only reaches (b). Seriously including (a) and (c)
   requires a free path, and that path *is* the Peace Prize story. **A decision for October onward**
4. **Whether we may store copyrighted material (the problem page)** (§4-1)
5. **App Review for minors + AI-generated content.** Stay out of the Kids Category (13+). Explain the
   guardrails in the review notes (deck §5)
6. **Whether co-presence actually gets used.** It's a cheap bet at zero cost, but if time-in-app doesn't
   rise it doesn't work as a billing funnel
7. **[Must close before submission] There is no crash monitoring.**
   `apps/mobile/pubspec.yaml` has `sentry_flutter: ^9.26.0` and there is a slot for the DSN, but **`lib/`
   contains not one `Sentry.` call and `main.dart` has no init** (confirmed 2026-08-09). So **nothing is ever
   sent**. After the 9/5 submission and release, a solo operator would never notice a crash and users would
   leave in silence. **A dependency that is present but inert is more dangerous than an absent one** (you go
   live believing it's covered). Sentry is also listed as a sponsor we can leverage.
   Design notes for when we wire it up: use `captureMessage(level: warning)` for degraded states rather than
   `captureException`; throttle so the same `board_id` doesn't fire repeatedly; send only the first few dozen
   characters of `tex` plus the shrink ratio.

   **All three layers are open** (confirmed 2026-08-09). Writing Dart alone won't send anything:

   | Layer | State |
   | --- | --- |
   | Dart code | Zero `Sentry.` calls; no init in `main.dart` |
   | Environment | `SENTRY_DSN=` in `dart_defines.env` is **empty** |
   | Build config | `codemagic.yaml` passes nine `--dart-define`s but **not `SENTRY_DSN`** |

   And `codemagic.yaml` archives dSYMs as an artifact with a comment saying they're "needed for crash
   symbolication (Sentry)". **We're storing the symbols with nowhere to send them.**

8. **[Commit-order constraint] Committing the board golden tests on their own will break CI.**
   The flutter job in `.github/workflows/ci.yml` runs **`flutter test` with no tag exclusions** on Linux
   (`codemagic.yaml` excludes them with `--exclude-tags golden`, so **GH Actions is the only effective golden
   gate**). When the reference PNG is **missing**, `matchesGoldenFile` fails with "file not found" rather
   than a pixel diff. Our policy is not to commit PNGs generated locally on macOS
   (`test/golden/README.md`), so **prepare Linux-baseline PNGs and commit them together with the test file**.

9. **The new dependency has never been through a native build.**
   Adding `flutter_math_fork` pulled in nine transitive packages around `flutter_svg` / `vector_graphics`,
   but all we've run is `flutter test` / `flutter analyze` (the Dart level). **With a 9/5 submission plan,
   finding out whether the changed dependency graph builds for the first time in a Codemagic production build
   is dangerous.**

10. **`livekit_client`'s declaration (`^2.3.5`) diverges from what it resolves to (`2.10.0`)** (§3-7). The
    board design assumes the 2.10.0 API, so a clean `pub get` could still resolve to the old version.
    **Not yet addressed.**

---

## 11. Next move

**Start with the W1 board spike.** The shortest entrance is to settle the schema in
`packages/contract/src/board.ts` and the data-channel contract first (existing policy is that mobile and the
agent both validate the same shape).
