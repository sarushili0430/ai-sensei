# @ai-sensei/guardrail

Pure functions used by both Workers and the agent. **No side effects, no dependencies**,
so the specification can be pinned by unit tests.

| Module | Role |
| --- | --- |
| `topic-guard.ts` | Builds a session's allowed units and matches the karte's unit tags |
| `latex-guard.ts` | Command matching for board LaTeX. Never send an unrenderable formula to the device |
| `plan-guard.ts` | Unit matching for study plans. Never pass a plan containing out-of-scope units |
| `problem-guard.ts` | Validity of the transcribed problem text. Never hand the senpai text with the answer mixed in |
| `math-speech.ts` | Normalizes Japanese STT's spoken maths |
| `spaced-repetition.ts` | The +1 / +3 / +7-day bookings and the notification wording |
| `progress.ts` | The streak and "filled holes" counters |

## The unit allow-list

The units detected from the photo, plus their prerequisites, become the allow-list.
`backend/api` passes that list to the senpai's prompt and to the session metadata.

```ts
const allowed = buildAllowedTopics(detectedTopicIds); // the photo's units + two levels of prerequisites
const topicsForPrompt = allowedTopicList(allowed);
```

**The default prerequisite depth (`conversationPrerequisiteDepth` = 2) must match the
number of levels the prompt promises the senpai.**
`prompts/senpai_board.{ja,en}.md` says the allow-list contains "two levels of
prerequisites", and going shallower keeps the second level out of the list, so the
description and the real data disagree.
**The default was made correct** rather than adding the option at the call site,
because the original bug was exactly the shape of "the caller forgot to write it".

`validateStep()` in `backend/agent/src/board.ts` checks a step's schema and its LaTeX;
it does not match the board's topic_ids against this allow-set. The question-text guard
from the old "the kouhai generates questions" path was deleted after the pivot, once it
had no production caller.

`filterHoleTopicIds()` applies the same allow-set to the topic_ids on the karte's
holes, because an out-of-scope tag makes the review notification off-target too.

| reason | What it prevents |
| --- | --- |
| `malformed_topic_id` | The id's shape is broken |
| `unknown_topic_id` | The LLM fabricated an id (university maths, another subject) |
| `topic_not_allowed` | In the curriculum, but not in the photo |

## Board LaTeX matching

`flutter_math_fork` is a Dart port of KaTeX and cannot render everything the original
accepts. **A command it cannot render reaches the device and that board line becomes
blank or throws.**

```ts
const verdict = checkBoardLatex(step.board.tex);
if (!verdict.ok) {
  // regenerate with latexRejectionGuidance[verdict.reason] attached
}
```

Validation has three stages (`docs/pivot_plan_v1.md` §3-6), and **only stage 2 lives
here**.

| Stage | Where | What it prevents |
| --- | --- | --- |
| 1 formula templates | the prompt | wrong **combinations** of allowed commands |
| 2 command matching | **`latex-guard.ts`** | commands the port does **not support** |
| 3 real KaTeX parse | `backend/agent` | **broken syntax** (unclosed braces, wrong arity) |

Stage 3 is not here so this package's "no external dependencies" stays true.
Character caps and the ban on multi-line environments (`align` etc.) are
`@ai-sensei/contract`'s job and are not implemented twice.

| reason | What it prevents |
| --- | --- |
| `unknown_command` | **Commands whose rendering was never measured** (`\ln`, `\overline`, `\left` and friends). `\href` and `\includegraphics` fall out as a side effect |
| `text_in_math` | **Prose or Japanese inside a formula.** `\text{よって}` becomes tofu (black bars). It is not a ban but a **wrong location**, so it gets its own reason and points at the `text` element |
| `unknown_environment` | Environments other than `pmatrix` / `cases` |
| `unbalanced_environment` | `\begin` and `\end` do not match |
| `row_separator_outside_environment` | `\\` or `&` outside an environment. A board is **one step = one line** |

**Only what has been rendered to PNG and inspected goes on the allow-list.** Never add
something "because it is in KaTeX's documentation": that the port may not support it is
precisely why this layer exists. What is unverified and on hold (`\ln`, `\overline`,
`\left`, `\right`, matrices of 3x3 or larger, `cases` with three or more rows) is
listed in `latex-guard.ts`'s comments.

**Drift also happens the other way.** Forgetting to allow something already measured
makes regeneration throw away renderable formulas, adding only latency and cost.
`measuredFormulas` in `latex-guard.test.ts` is **the cross-check between the measured
formulas and the allow-list**; when measurement adds a formula, add it there too.

The guidance (`latexRejectionGuidance`) **says where to go**. Ending at "write what
cannot be expressed in Japanese" makes the LLM write `\text{よって}`, fail as
`text_in_math` the next turn, and loop. Anything that cannot be a formula is always
sent to "put it on the board as `text`".

**No Japanese in formulas.** `\text{よって}` garbles because KaTeX's font has no
Japanese glyphs. Not only the `\text` family but `\mathrm{よって}` and bare kana or
kanji are rejected for the same reason (listing command names cannot close it, so the
whole `tex` is checked).

`\\` and `&` pass **only inside `pmatrix` / `cases`**. Rejecting them unconditionally
loses matrices and case analysis; allowing them unconditionally splits a one-line board
into two.

## Study-plan unit matching

`plan.ts` in `@ai-sensei/contract` is a dependency-free layer and **knows nothing about
prerequisites**. So a plan whose interview recorded "the test covers trigonometry" can
contain a day of "two hours of vectors", pass the schema and reach the screen. This
closes that hole.

```ts
const scope = checkPlanScope(plan.intake.scope.topic_ids);
if (!scope.ok) {
  // rebuild it with planRejectionGuidance[scope.reason] attached
}
const { rejected } = filterPlanItems(plan.days.flatMap((day) => day.items), scope.allowed);
```

**Scope and assignments are rejected differently on purpose.**

| | How it fails | Why |
| --- | --- | --- |
| **Scope** (`checkPlanScope`) | One broken entry **fails the whole thing** | Silently dropping one unit produces a plan aimed at **a narrower test than the real one**. The student reaches the day without studying part of the scope, with no way to notice |
| **Assignments** (`filterPlanItems`) | Dropped **one at a time** | They are generated output, so one out-of-scope day leaves the rest usable (as with `filterHoleTopicIds`) |

**Prerequisites go two levels deep** (`planPrerequisiteDepth`). It is the **same value
as the conversation side (`conversationPrerequisiteDepth`) but kept a separate
constant** - the conversation side may want to go shallower for cost (session time),
and having plans silently follow would start rejecting legitimate revision days ("a day
to recall trigonometric ratios first") as out of scope.

The reason it stops at two comes from measuring the real curricula (there is a table in
`plan-guard.ts`): the longest prerequisite chain is only five levels, and **it saturates
at two** (level three and beyond adds about 0.5 on average). Three levels does not buy
another day of revision; it just sprinkles in distant units. And because prerequisite
edges extend along the learning order, **two levels never reach another strand**
(vectors never enter a trigonometry plan).

The guidance (`planRejectionGuidance`) must point **away from rewriting the scope**.
Returning only "out of scope" makes the LLM rewrite the scope
(`intake.scope.topic_ids`) to make things add up - which **falsifies the interviewed
facts**, so the plan passes while describing a different test.

**Mixed curricula are checked only here** (`mixed_curricula`). One plan belongs to one
test, so Japanese and overseas curricula never share a scope. A mix means the LLM drew
on both memories, and the rest of the scope is untrustworthy too.

## Problem-text validity

The transcribed `problem_text` goes straight to the board LLM and becomes **the
starting point of what that lesson teaches**. An answer mixed in makes the senpai copy
the answer instead of building the method, and **the board degrades into an answer
display** (post-revision promise 1 permits giving the answer, but the board's value is
the reasoning).

```ts
const verdict = checkProblemText(problemText);
if (!verdict.ok) {
  // backend/api's resolveSessionProblem() folds problem to null and logs the reason
}
```

**The caller does not re-analyse** (`resolveSessionProblem()` in `backend/api`).
Answers get mixed in because of *what part of the page was photographed*, so **sending
the same photo again returns the same thing** - it usually just buys the same result
for the price of Vision plus seconds of session start.
On rejection, `problem` becomes `null` and the senpai opens with "could you read the
problem out?".

That is why **`problemRejectionGuidance` is currently unused**. It is kept, paired with
its reason, for whenever a regeneration path is added
(`latexRejectionGuidanceByLocale`, by contrast, really is attached by the agent when
regenerating a board).

**The policy is "perfection is not the goal; when unsure, let it through".**
Over-detection does more harm: rejecting a legitimate problem text leaves
`problem_text` empty and the senpai starts from "(no problem photo)" = **teaching
without looking at a problem that is right there**, the very state we wanted to avoid.

| reason | What it prevents |
| --- | --- |
| `solution_included` | The chapter's answers, red commentary or `∴` flowed into the problem text. **Headings require a bracket or a colon**, so "write on the answer sheet" and "round your answer" are not caught |
| `not_a_problem` | A fragment with no prose at all (just `x^2 - 3x + 2 = 0`). It does not say what is being asked |

**What is deliberately absent, and why**, is at the top of `problem-guard.ts` ("よって"
occurs in questions too; a bare `Answer:` is printed above a blank answer box on the
page before anything is solved; and so on).

**It takes no locale.** Answer headings do not share character sets between Japanese
and English, so applying both at once cannot confuse them. One fewer argument removes
the "passed the wrong locale and it slipped through" path entirely.

## Spoken-maths normalization

"エックスのにじょう" -> `x^2`, "さんぶんのに" -> `2/3`.
The policy is **do not overreach**, and tests pin that ordinary Japanese is not broken.
"かける" and "わる" become operators only when sandwiched between two numbers (turning
"時間をかける" into "時間を×" would corrupt the karte's raw material itself).
Context-dependent correction (is "ディー" the distance d or the discriminant D) is the
job of the LLM, which has the photo's context.

## Spaced repetition

`scheduleReviews(holeIds, completedAt)` returns three bookings per hole.
The baseline is the **local date** (JST by default), not UTC, and notifications land at
20:00. A test pins that "the next day" does not slip for a session just after midnight.

The notification wording comes from `buildReviewPrompt()`. It takes the form of a
request from the agent and uses no blaming vocabulary (a test bans that vocabulary).

## Progress counters

`computeStreak()` **keeps the streak alive if it ran through yesterday**, so a user who
opens home first thing in the morning is not disappointed every day. It breaks only
after a full day's gap.

`ProgressCounters` holds only `streak_days` / `filled_holes` / `open_holes` /
`last_session_date` and no score-like field (a test pins the key list).
