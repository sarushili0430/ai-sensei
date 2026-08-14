# @ai-sensei/contract

The contract joining `apps/mobile` (Dart), `backend/api` (TS) and `agent` (TS).
It crosses languages, so **schemas and fixtures** are authoritative, not types.

```
src/         zod schemas (authoritative on the TypeScript side)
fixtures/    real-data samples. Both the TS and Dart tests parse these
schema/      JSON Schema generated from zod (the reference for Dart; committed)
```

## Detecting contract drift

1. `src/fixtures.test.ts` — parses every fixture with zod (TS side)
2. `apps/mobile/test/contract_fixture_test.dart` — parses the same fixtures with the
   freezed models (Dart side)
3. `src/json-schema.test.ts` — checks `schema/*.json` matches zod

After changing zod:

```bash
pnpm --filter @ai-sensei/contract generate:schema   # regenerate schema/*.json
pnpm test                                          # confirm the fixtures still line up
```

When a fixture needs a new shape, **write the fixture first, then change the schema**.
Fixtures are the most-read part in review, so write them at the granularity of a real
conversation.

## What the karte schema protects

- **No fields for scores or accuracy.** It is `strict()`, so adding `score` later
  fails the tests. Only streak days (`streak_days`) and filled holes (`filled_holes`)
  are counted.
- **At most five holes.** The cap is in the schema so the karte never becomes a tool
  for blame.
- **Nowhere for answers or worked solutions.** There are only `said_well` / `holes` /
  `term_notes`, with no field for the correct method by design.
  **The constraint remains, but its reason changed.** It used to be "never give the
  answer". After the pivot ([`docs/pivot_plan_v1.md`](../../docs/pivot_plan_v1.md) §0,
  the revision to promise 1: "give the answer, then have them teach it back"), the
  senpai does teach methods. Methods go on the **board** (`src/board.ts`), not in the
  karte. The karte records **what could be observed at the time** and is not where the
  AI's own teaching is written back (writing it back would reinforce the AI's
  misreading through the 1/3/7-day reviews - the same reason as the quiz's design
  constraint in plan §2).
- `severity` only affects review ordering and never appears as a number in the UI.

## What the board schema protects

The only place methods live, which is exactly why it needs constraints (the reasoning
is at the top of `src/board.ts`).

- **`speech` is at most 120 characters**, derived from Japanese TTS at ~330 chars/min,
  i.e. 20-25 seconds per step. "Formulas, working and figures on the board; speech only
  for questions and connective tissue" (plan §3-1) is not a look but **a main cost
  driver**, so it is enforced by the schema rather than asked for in the prompt.
  Reading a formula aloud always exceeds it.
- **No freehand drawing.** The elements are `latex` / `text` / `plot` / `triangle` /
  `circle`, and the LLM emits only parameters. There is no field to receive SVG or
  canvas commands.
- **A whole worked answer cannot be poured into one element.** Three things block it:
  the `tex` (200) and `body` (100) caps, the ban on multi-line LaTeX environments
  (`align` etc.), and the **per-output** step cap (12). Per-element caps alone can be
  escaped as "one line at a time, but 40 lines".
- **There are two step caps. Confusing them erases the board every turn.**
  | Constant | What it caps | Value |
  | --- | --- | --- |
  | `boardLessonStepsMaxCount` | Steps **the LLM may emit at once** (`board-lesson`'s `steps`) | 12 |
  | `boardStepsMaxCount` | Steps stackable on **one board** (= one problem); the wire's `index` / `step_count` | 40 |

  A board lives for one problem, and several explanations (diagnose -> teach -> have
  them teach back) stack onto the same `board_id`. **Sending `board_open` on every LLM
  call erases the board on every exchange** (breaking plan §3-2's "never erase earlier
  lines" each turn).
- **What the LLM emits is separate from what flows on the data channel.**
  `board-lesson` carries no identifiers (so hallucinated ids cannot reach the delivery
  layer). Destination, ordering and board switching are the envelope's job (each
  message in `board-channel-log`). **Assigning running numbers is also the delivery
  layer's job**; the LLM does not know which call this is (telling it puts hallucinated
  numbers on the wire).
- The transport is **LiveKit Text Streams** (agent -> mobile, topic `board`), not
  `backend/api`. That is why it does not appear in the endpoint table below.
- **LaTeX command contents are not matched here.** This layer checks length and "is it
  one line". Whether `flutter_math_fork` can render it is `packages/guardrail`'s and the
  agent's job (plan §3-6's three stages). contract is a dependency-free layer, with the
  same split as `topicIdSchema`.

## What the problem text (grounding) protects

Plan §0's decision 4, "send the problem and the notes together". The absence of a field
here is why the agent reused `photo_summary` ("what is in the picture") as
`problem_text` = **the senpai taught without seeing the problem itself**.

- **The two photos have different lifetimes.** `sessionPhotoParts` splits the part
  names. `photo` (notes) is stored in R2; `problem_photo` (a textbook or workbook page
  = **someone else's copyrighted work**) is **discarded after analysis and never
  stored**. This settles what §4-1 / §10-4 left open, as "discard after analysis".
- **Only one of the two is needed; reject only when both are missing.** Neither the
  notes nor the problem is mandatory.
  **Back when notes were mandatory, this contract broke its own discard promise**: a
  student with no notes had no route but to put the page in the notes slot, so someone
  else's copyrighted work ended up stored in R2. The only way to guarantee discarding
  was to remove the motive for putting a page in the notes slot, so notes stopped being
  required.
  Legitimising students who do not photograph their notes is accepted, because
  **"I can't even start" is a central tutoring request** (after the revision to promise 1).
  The insurance against misreading lives in the teach-back phase and is untouched (§1-1).
  **The remaining hole**: a problem sent in the `photo` slot is stored. Slot confusion
  cannot be prevented.
- If one is broken, the other still lets the session proceed. It is rejected **only
  when zero photos were readable**.
- **`text` and `source` are one object**, so "text without a source" is unrepresentable
  (the same idea as `karte.ts`'s `status` / `filled_at`).
- **`problem` is returned to the app too**, so the §4-1 hint can be shown only when it
  is `null`, and so **the transcribed problem text is shown verbatim and a misreading
  surfaces early** (§1-1).
- **600 characters is a safety valve.** Exceeding it means the whole page was
  transcribed, mixing in the chapter's answers. It is not truncated but **discarded
  whole** on the `backend/api` side (so a problem cut mid-question is never taught).

### `session-metadata` — the agent's context, carried on the LiveKit token

It rides the **token's `metadata` claim**, not an HTTP body, so it does not appear in
the endpoint table below. It is nonetheless the heaviest part of the backend/api <->
agent contract, and **flows straight into the conversation prompt's blanks**. Running
it without a type is what caused the bug above.

- String fields are **pre-formatted** and pasted straight into the prompt. Placeholders
  for empty values included, they match `locale`'s language.
- **`problem_text` is never empty** (`.min(1)`). When unreadable it still arrives with
  that language's placeholder (in Japanese, `(問題の写真なし)`), so **the agent must
  not fill blanks**. Two fill sites would drift from the wording
  `prompts/senpai_board.*.md` matches by name, and the instruction "do not reconstruct
  the problem text by guessing" would stop firing.
- **`visible_work` is never empty either** (`.min(1)`), and arrives with **three
  distinguishable states**: bullets (readable), `(なし)` (**photographed, but no sign of
  work**), and `(ノートの写真なし)` (**never photographed at all**).
  The third appeared once the problem-only path was legitimised; conflated, the senpai
  starts hunting for "where they got stuck" in a student who has not started.
- The new API's **`review_hole` holds one entry only for `review` and is `null` for
  `new`.** A review has no problem photo, so the hole's `desc` is never disguised as
  `problem_text`. It carries only the target `topic_id`, the description of where they
  stalled last time and the student's own words behind it - never the whole previous
  karte. Mixing in `said_well` or other holes would widen a one-hole review into a
  re-lecture of the entire previous session.
  The field itself may be omitted only during the deployment window where an old API
  coexists with a new agent. The agent logs a warning for such a review and degrades to
  the old board-less conversation.

## What the study-plan schema protects

Built by voice alone ([`docs/pivot_plan_v1.md`](../../docs/pivot_plan_v1.md) §4-3).
**Form input was the option rejected in §1**, so adding one field to `src/plan.ts` is
treated as adding one senpai question. Only three things are asked: **the test date,
the scope and the materials in use**.

- **No score fields.** There is nowhere for target scores, accuracy, comprehension,
  deviation values or completion rates. It is `strict()`, so adding one later fails the
  tests. Study plans are **where promise 2 is easiest to break** ("target: 80", "this
  week's completion rate" are planning-app staples), and they are meant for §5's parent
  report, so a number placed here **reaches the parent verbatim** (the ❌ side of §5-2).
  **Actual study time is not held either** - `minutes` is a planned estimate, and
  holding measurements is one step from "X hours this week" to ❌ "study-time
  leaderboard".
- **Facts and assignments are separate.** `intake` (the facts heard) does not change on
  a rebuild; a rebuild regenerates only `days`. Catching a cold does not move the test
  date. Conflated, every rebuild re-runs the interview (= a form again).
- **You cannot assign material the student does not have.** `material` is an **index**
  into `intake.materials`, not a name. Held as a string, "Blue Chart example 42" could
  be assigned to a student who does not own Blue Chart (the same trick as `board.ts`'s
  `angleMark.vertex`).
- **You cannot write an unkeepable plan.** A day totals at most `planDayMinutesMax`
  (120 minutes), and no assignment passes the test date. An unkept plan teaches only
  "plans are not for me", so the cap lives in the schema.
- **Dates are calendar days** (`YYYY-MM-DD`), never instants. Held as UTC instants,
  **the test moves a day earlier** depending on the device timezone. Treated like
  `karte.ts`'s `last_session_date`.
- **The degraded version emits the same shape.** In §7's "what to drop first" ①, plan
  generation falls back to "the senpai proposes a fixed template". Creating no field
  only an LLM can fill is the condition for that, and who built it is recorded in
  `source` (`senpai` / `template`). Without it, **nobody would notice a degraded build
  went into production**.
- **Unit validity is not matched here.** Whether the scope's `topic_ids` are in the
  curriculum, and whether an assigned unit falls within the scope (or its
  prerequisites), is `packages/guardrail`'s job. contract is a dependency-free layer
  and knows nothing about prerequisites (the same split as `topicIdSchema`).
- **A day absent from `days` differs from a day with empty `items`.** The former is
  outside the plan; the latter is a day the senpai placed as "let's rest here". A plan
  with no rest days gets abandoned whole on the first day it slips.
- **The LLM's unit is one turn, not one plan** (`study-plan-turn` = `{speech, plan}`).
  A plan is born *during* the interview, so the turn asking "when is the test?" and the
  turn producing the plan share one shape (composed like `board.ts`'s
  `{speech, board}`). Identifiers, `source` and the rebuild timestamp are not given to
  the LLM; the storage side adds them.

| Schema | Who reads it |
| --- | --- |
| `study-plan-turn` (`planTurnSchema`) | The agent validating plan-mode LLM output |
| `study-plan` (`studyPlanSchema`) | The plan screen and (eventually) the parent report |

## Invariants absent from JSON Schema

`schema/*.json` is the reference for Dart implementation, but **zod's `.refine()` /
`.superRefine()` leave nothing in JSON Schema**. Anything expressible as a single
regex is written with `.regex()` so it survives as a `pattern` (and
`src/json-schema.test.ts` pins that it does). The rest cannot be expressed in JSON
Schema at all, so **the Dart side must implement it by hand**. Of contract drift
detection's three legs, **only the Dart leg thins out here**.

| Invariant | Where | What Dart must do |
| --- | --- | --- |
| `domain` has `min < max` | `plot` | Check before drawing and reject |
| `focus` is a substring of `text` | `sentence` | If not found, **draw the sentence without the underline** (dropping the sentence would lose the example) |
| A step's `index` starts at 0 and increases by 1 (**within one output for `board-lesson`; within one board for `board_step`**) | `board-lesson` / `board_step` | Compare against the expected value (**count per board**, not per output) |
| An envelope's `seq` starts at 0 and increases by 1 (across message kinds) | `board-channel-log` | A skip means **treat it as a gap** |
| `board_close.step_count` matches the number of steps actually delivered | as above | Detects **a missing tail** |
| Steps only ever come between `board_open` and `board_close` | as above | Discard messages for an unopened `board_id` |
| `board_open` erases the previous board (nothing else does) | as above | Clear the surface on receipt |
| Only one session's messages are mixed in (`session_id` is identical throughout) | as above | **Discard messages for another session** (destination check) |
| `days[].date` ascends and never repeats | `study-plan` | On a duplicate, **reject rather than keeping one** (there is no way to say which is right) |
| `days[].date` is on or before the test date | as above | Do not draw days after the test |
| `items[].material` is within `intake.materials`'s index range | as above | Out of range means **draw without the material name** (never show a book that does not exist) |
| A day's `minutes` total at most 120 | as above | If exceeded, **do not show it** (never hand over an unkeepable plan) |

**`seq` and `step_count` are mobile's gap detection itself.** Implemented from the JSON
Schema alone, a moth-eaten board is displayed silently. `session_id` is the same kind
of thing: a destination check so **a misrouted delivery is dropped by the receiver**.

### Present in JSON Schema, but not expressible in Dart's types

These are different. **The constraint is emitted into JSON Schema**
(`src/json-schema.test.ts` pins that), but **Dart's `List<T>` cannot express a fixed
length in the type**. Reading the reference does not give you a type, so **runtime
checks are needed as with the table above**.

| Invariant | In JSON Schema | What Dart must do |
| --- | --- | --- |
| `triangle.vertices` is exactly three points | `minItems: 3` / `maxItems: 3` | Check the length is 3 at runtime |
| `triangle.labels`, if given, has all three | as above (`labels` is optional) | Optional; if present, check the length is 3 |

zod uses a tuple (`z.tuple`) because of `board.ts`'s policy that **a fixed-length
sequence of same-kind values is an array** (only heterogeneous pairs - `{x, y}`,
`{min, max}` - become objects).

## Main endpoints

| Method | Path | Who calls it |
| --- | --- | --- |
| POST | `/v1/sessions` | mobile (photo + meta as multipart. **Nothing is counted yet**) |
| PATCH | `/v1/sessions/{id}/topics` | mobile (applying units removed in the chip UI) |
| POST | `/v1/sessions/{id}/start` | mobile (**starts the conversation, counting today's use**, and returns the room key) |
| POST | `/v1/sessions/{id}/complete` | agent (internal token required) |
| GET | `/v1/me/progress` | mobile (home screen) |
| GET | `/v1/me/reviews` | mobile (the free quiz. Whether a voice lesson is allowed comes from `/v1/me/progress`'s `limits.lesson_allowed_today`) |
| POST | `/v1/me/reviews/{holeId}` | mobile (the quiz self-report) |
| POST | `/v1/webhooks/revenuecat` | RevenueCat |

Every error is returned as `{ "error": { "code", "message" } }`.
Clients branch on `code` and display `message` as-is (written without nagging).
