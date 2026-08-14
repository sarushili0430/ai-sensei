# Inception deck — ai-sensei (Katarute)

Written 2026-08-05 / Covers: every sprint up to the 2026-09-30 23:45 PDT deadline
Primary sources: [`design_direction_v0.html`](design_direction_v0.html), [`adr.md`](adr.md)
2026-08-09: §0 (the first of the four promises) was revised by the decision in
[`pivot_plan_v1.md`](pivot_plan_v1.md); that document is the primary source for the
revision's reasoning and design.

This is an agreement about what is being built, not a specification.
**When in doubt, come back here. What is not written here has a reason for not being done.**
Sprint plans, PR scope calls and "should we add this feature" all get checked first
against §2's one-liner and §4's "won't do" list.

---

## 0. In one line (memorise this, if nothing else)

> **Give the answer. Then have the student teach it back to you.**

English (the canonical wording for submissions, the store and the demo video):

> **The AI tutor that teaches you — then asks you to teach it back.**

This sentence appears **in exactly these words** in the README, the store description,
the opening of the demo video and the first line of the pitch.
Wanting to reword it is the signal that a feature has outgrown the one-liner. Do not fix
the sentence; question the feature.

The one-liner contains four promises. **A change that breaks any one of them is not a
feature but a different product.**

1. **Teach, then have them teach it back.** The senpai teaches with a board and asks for
   an explanation on the spot.
2. **No scores.** Only streak days and filled holes are counted.
3. **Never shame a pass.** What could not be explained becomes a hole, which is value.
4. **Never nag.** Notifications and paywalls are written as the senpai's judgement: no
   numbers, no orders, no pressure.

---

## 1. Why are we here

Apps that give you the answer from a photo (QANDA and the like) are already in every
high-schooler's hand.
**The cost of obtaining an answer is zero, and they still cannot solve the mock exam.**
The reason is clear: reading a solution and feeling you understand it is a different
state from being able to explain the steps and the reasons in your own words. And the
student cannot tell the two apart.

So we build **the side that finds the gaps**. The side that hands out answers is
saturated.

- Learning-science backing: the self-explanation effect, and the protégé effect, where
  teaching deepens learning (Teachable Agent research).
  Note: the learning pyramid has weak evidence and **is not used in the pitch**.
- The AI's stance: not an examiner but "a kouhai who wants to be taught".
  Everything is written in the register of a naive question: "wait, why do you use the
  discriminant here?"
- The queue we are in: RevenueCat Shipaton 2026 (entering Next Gen / Peace Prize /
  OneSignal "Keep Them Coming Back" / HAMM / #BuildInPublic / Design).
  **The fact that this is a contest with a deadline** weights every decision below.

## 2. Elevator pitch

> For **Japanese high school students** who **mistake "I read the solution" for "I understand"**,
> **Kataru-te (ai-sensei)** is a **spoken-explanation study app** in which **a senpai AI teaches you
> with a shared whiteboard, then has you teach it back on the spot**.
> It **turns the moments you stumble while teaching it back into "gaps" on a chart, and asks you
> again after 1, 3, and 7 days**.
> Unlike **photo-search math apps that hand you the answer and stop there**, our product
> **teaches you — then makes you teach it back**, catching the illusion of understanding
> before it settles in.

**A check on the claim**: strip the proper nouns from that paragraph and does the
differentiation survive? Yes ("teaches, then makes you teach it back", "gaps remain",
"revisited at intervals"). If a phrasing does not survive it, it has drifted into
showing off technology.

## 3. Package design (what it says on the shelf)

- **App name**: Katarute (kataru "to tell" x karte). Undecided. If it is settled, this
  section becomes authoritative
- **Subtitle (30 chars)**: Give the answer. Then have the student teach it back.
- **English canonical**: The AI tutor that teaches you — then asks you to teach it back.
- **Three lines on the back of the box**:
  1. Photograph the problem and your notes, and the senpai teaches it with a board
  2. Then teach it back; where the explanation stalls stays as a "gap in understanding"
  3. Until it is filled, the senpai asks again after 1, 3 and 7 days
- **Screenshot order** (1179x2556, no device frame): (1) the lesson mode with the senpai
  teaching on the board -> (2) the celebration screen where a successful teach-back
  lights up the senpai's face -> (3) the karte with yellow (said it) and pink (a gap)
  markers -> (4) the streak and "filled holes" counters -> (5) the return screen after
  1, 3 and 7 days
- **Words that are never written**: "AI explains it", "accuracy", "deviation score",
  "losing streak if you skip"

## 4. The "won't do" list

| Will do | Won't do | Later |
| --- | --- | --- |
| Maths (I, A, II, B, III, C under the current guidelines) | Subjects other than maths | — |
| One turn of photograph -> board lesson -> teach-back -> karte -> review | Teaching and stopping there (no teach-back on the spot) | — |
| Study plans built by voice | A co-presence (study room) mode, or form-input study plans | — |
| Real-time voice conversation (LiveKit) | Implementing WebRTC ourselves | Text input for places you cannot speak (§7's concern) |
| Streak and filled-hole counters | XP, leagues, quests, correctness scores | — |
| Starting anonymously (device id) | Requiring account creation | Sign in with Apple (v1.1) |
| iOS (TestFlight -> App Store) | Publishing on Android | Following after submission (Flutter, so the implementation is shared) |
| Two locales, Japanese and English | A third language | — |
| RevenueCat billing + a paywall right after the first karte | Social features, leaderboards, a shared timeline | — |
| Pure-function units + golden tests | Automated E2E (manual checking on TestFlight instead) | — |

**How to use this list**: a PR implementing something in the "won't do" column is
rejected however small. To move an item, **open a PR that rewrites the list first**.

## 5. Find the neighbours (who we depend on)

| Party | What they hold over us | Our mitigation |
| --- | --- | --- |
| **Apple App Review** | Publication itself; how AI-generated content and age rating are handled | Submit the first binary at the end of August to leave a buffer for rejections. The guardrails *are* the countermeasure against inappropriate output |
| **LiveKit (Cloud / Agents)** | Conversation latency, barge-in quality, whether the agent can be hosted | The Node SDK is pinned at `^1.6.1` ([ADR 0002](adr.md#adr-0002)). If hosting is unavailable, a long-lived container |
| **STT / LLM / TTS** (Deepgram, Claude, ElevenLabs) | Japanese recognition accuracy, cost, latency | Formulas are corrected by the LLM, which has the photo's context. The free tier is fixed at one session a day, five minutes max, capping cost |
| **RevenueCat** | The entry requirement itself (SDK billing is mandatory) | [`revenuecat.md`](revenuecat.md). A keyless build disables billing entirely so CI passes |
| **OneSignal** | Spaced-repetition reminders = the basis of the "Keep Them Coming Back" entry | Bookings for +1/+3/+7 days from `/complete`. The schedule lives on OneSignal's side, so no cron |
| **Cloudflare (Workers/D1/R2/KV)** | The API, photos, kartes and free-tier metering | Two environments, develop and production. Only the binding names are shared ([`deploy.md`](deploy.md)) |
| **Codemagic / GitHub Actions** | The distribution route | mobile -> Codemagic, backend -> Actions ([`ci/`](ci/README.md)) |
| **Shipaton judges** | The prizes. English materials, a two-minute demo video, a promo code unlocking everything | The English locale and the promo code are treated as **submission artifacts**, not features, and are frozen in W4 |
| **The high-school students themselves** | Retention. The reluctance to speak aloud | Seeding into study-account culture (X/TikTok) from W5 |
| **The developer (solo)** | Everything | §8's "what to drop first" is decided in advance |

## 6. Sketch the solution

```
Flutter app ──HTTPS──▶ backend/api ──▶ create the LiveKit room + start the agent
     │                    │  Analyses the photo with a Vision LLM, deciding the unit and question policy
     │                    │  Storage: R2 (photos) / DB: D1 / metering: KV
     └──WebRTC────────▶ agent
                          VAD -> Japanese streaming STT -> the LLM (senpai persona)
                          streams {speech, board}. Each time a step completes, the board
                          is sent over LiveKit Text Streams and the speech goes to TTS
                          right after -> barge-in handled. At the end the karte is
                          generated from the transcript and POSTed to backend/api's
                          /v1/sessions/{id}/complete
                          -> OneSignal books +1 / +3 / +7-day return pushes
```

The reasons behind the technology choices are not written here (that is [ADR](adr/)'s
job). As a deck, this diagram says one thing only:

**"What may be taught" is protected by the architecture, not by prompt wording.**
Question generation has two guardrails: the prompt limits it to "what is in the photo ∩
the curriculum map's scope", and the server matches the `topic_id` against an allow-list,
regenerating what falls outside (`packages/curriculum`'s plain JSON is authoritative, and
both `backend/api` and `backend/agent` go through the same matching).

## 7. What keeps us up at night

> **Update after the 2026-08-09 pivot**: 5 and 7 are resolved (noted below). The new
> biggest risk is **8** (the 8/16 board gate). 1-4 and 6 were not revisited in this
> revision ([`pivot_plan_v1.md`](pivot_plan_v1.md) §10).

1. **Talking maths in Japanese is hard in the first place.** Misrecognition of
   "にじょう" and "ぶんの", plus conversation latency.
   -> Judged at the **Go/No-Go gate** at the end of W2; if it fails, fall back to a
   recorded one-question-one-answer format (the UI and the karte are shared, so the
   switching cost is small). **Waving that gate through is the biggest risk.**
2. **Rejected in review and missing 9/30.** -> Submit first at the end of August. A first
   submission in mid-September is dangerous.
3. **The agent's host is unsettled.** If LiveKit Cloud's agent hosting is unavailable,
   operating a long-lived container falls on one person (the open issue in
   [ADR 0002](adr.md#adr-0002)).
4. **Conversation costs money.** STT+LLM+TTS runs a few to a dozen-odd yen a minute.
   Free-tier metering is **counted on the server** (against client tampering). Break that
   and the losses are unbounded.
5. **High-schoolers cannot speak aloud.** On the train, in the living room, late at night.
   Always-on conversation raised the weight of this open issue.
   -> **Largely resolved by the pivot.** Making the review entrance "one question, ten
   seconds, entirely in text" means reviews work without speaking
   ([`pivot_plan_v1.md` §2](pivot_plan_v1.md)). But **the lesson mode itself - being
   taught on a board and teaching it back on the spot - still assumes voice**; only the
   review entrance changed.
6. **If the solo developer goes down, everything stops.** -> Features freeze in W4. From
   W5 it is growth and polish only.
7. **"We won't give you the answer" just looks like an inconvenience.** The first
   onboarding screen declared "we do not give answers" to set expectations (implemented).
   -> Every added word of that declaration sounded more inconvenient, so screens 3 and 4
   **make them do it once** instead. Being asked by the kouhai, explaining or pressing
   "I can't put it into words", and seeing the result become a line in the karte - one
   round trip with no photo and no voice ([ADR 0004](adr.md#adr-0004)).
   -> **Removed by the revision.** With promise 1 now "teach, then have them teach it
   back", there is no longer any need to lower expectations by declaring "we do not give
   answers" (§0).
8. **[New, currently the biggest risk] The 8/16 board gate.** Does one problem taught with
   a board reach "I get it"? Do not wave it through - do not repeat the mistake made with
   concern 1. There are two fallbacks if it fails: templated solution steps if the
   generation quality is not there, and constraining the guardrails to what can be
   rendered if the rendering breaks ([`pivot_plan_v1.md` §3-4](pivot_plan_v1.md), §10-1).

## 8. Size the work

The deadline does not move: **2026-09-30 23:45 PDT**. The target is **early submission on
9/25**. As of 2026-08-05 the W1-equivalent skeleton is in the repository (monorepo,
two-environment Workers deploy, RevenueCat, Codemagic distribution, the main screens,
karte generation, OneSignal bookings, curriculum v0, guardrails).

| Week | Work |
| --- | --- |
| W1 (from 8/3) | Devpost/Ship Kit, Apple Developer / the public monorepo (MIT) / **the LiveKit spike** |
| W2 | Finish the conversation pipeline (barge-in, formula correction, karte generation) / **end of W2: the Go/No-Go gate** |
| W3 | RevenueCat + paywall / OneSignal + the review flow / TestFlight distribution |
| W4 (to end of August) | Polish, the English locale, icon and screenshots / **submit to App Review, freeze features** |
| W5-6 | Launch, acquiring real users (seeding study-account culture) / weekly #BuildInPublic posts |
| W7 | Gathering numbers (downloads/retention/conversion) / the demo video (two minutes, English subtitles) |
| W8 (to 9/30) | The full submission set in English / **early submission on 9/25** |

**What to drop first if we fall behind (decided in advance)**:
(1) the kouhai's follow-up question (the Premium case stands on the review feature alone)
-> (2) shrink spaced repetition from three steps to the next day only
-> (3) the English locale on the main screens only (the rest covered by the demo video's
English subtitles).
**TTS and the karte are the core of the demo and are never dropped.**

## 9. What are we giving up (trade-off sliders)

```
Deadline (9/30)      ■■■■■■■■■■  Absolute. It does not move
Purity of concept    ■■■■■■■■■□  §0's four promises hold even against the deadline
Experience polish    ■■■■■■■□□□  Enough to aim at a Design Award. Matching the board's pen and the karte's marker in one stroke style is the biggest payoff
Scope                ■■■■□□□□□□  Rearranged once by the 2026-08-09 pivot. From here it only moves in the direction of trimming §4's new list
Code quality         ■■■■■□□□□□  A public repository, so assume it is read. But no E2E
Feature count        ■■□□□□□□□□  One complete turn of the core loop matters more than the number of features
```

No ties. **Deadline > purity of concept > experience > quality > quantity.**
When unsure whether to add something this week, ask only whether it can be added without
lowering a higher slider.

## 10. What it will take

- **Team**: solo (a student). There is no reviewer, so CI and the ADRs stand in for review.
- **Money**: Apple Developer $99/year / LiveKit, Cloudflare, Codemagic and Sentry on free
  tiers / STT, LLM and TTS metered (covered by sponsor credits).
  **The cost ceiling *is* the free-tier design (one session a day, five minutes max).**
- **Time**: eight weeks, of which only W1-W4 (four weeks) can go to feature development.
- **Repository state**: `pnpm run verify` and `fvm flutter test` must always pass.
  The Claude Code on the web session-start hook keeps lint and tests passing from the
  moment a session opens.

---

## Sprint entry checklist (read every sprint)

1. Which word of **§0's one-liner** does this sprint's output strengthen? (If none, why
   are we doing it?)
2. Does it touch §4's "won't do"?
3. Does it lower a higher slider in §9?
4. Which of §7's concerns dies this week? (If none can, when will it?)
