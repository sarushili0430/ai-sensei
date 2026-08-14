# prompts/

System prompts and few-shot examples. **The Markdown is authoritative**, kept here so
it can be reviewed as a diff.

File names are `<id>.<locale>.md`. **Each language gets its own book**
([ADR 0005](../docs/adr.md#adr-0005)).

| id | Where it is used | Role |
| --- | --- | --- |
| `photo_analysis` | backend/api (Vision LLM) | Notes photo -> unit detection, question seeds |
| `senpai_conversation` | agent (conversation LLM) | The senpai persona plus the teach-back guardrails ([pivot plan v1](../docs/pivot_plan_v1.md) §2) |
| `question_types_few_shot` | agent | Few-shot examples aligning the four ways of asking while listening to teach-back |
| `karte_generation` | agent (at session end) | transcript -> karte JSON |
| `math_speech_hints` | both | Correction hints for spoken maths (§4(d)) |
| `senpai_board` | agent (board LLM, new and review) | The senpai persona plus board JSON, grounded in the photo or the target hole ([pivot plan v1](../docs/pivot_plan_v1.md) §2, §3) |
| `study_plan` | agent (plan mode) | The senpai building or rebuilding a study plan **by ear** (same, §4-3) |

There are two locales, `ja` and `en`. Tests fail unless **id count x 2 locales** are
all present (adding only one makes that language's sessions silently fall back to
Japanese). Each new id adds two `.md` files and an entry in `promptIds` in
`packages/prompts/src/index.ts`.

Never build this by appending "answer in English" to a Japanese body. That only
restates the persona and the bans in Japanese, and the few-shot examples stay
Japanese. Speaking English **with no example of the tone** drifts from the senpai's
voice towards an examiner's.

## Loading from TypeScript

Workers and the agent cannot assume a filesystem, so it goes through
`packages/prompts/src/generated.ts`, where the Markdown is converted into string
constants. **Do not edit it by hand.**

```bash
pnpm --filter @ai-sensei/prompts generate   # .md -> generated.ts
```

Editing a `.md` and forgetting to regenerate fails
`packages/prompts/src/index.test.ts`.

```ts
getPrompt("senpai_conversation", "en");       // fetch by language
conversationSystemPrompt(variables, "en");    // few-shot and speech hints bundled in English too
boardLessonSystemPrompt(variables, "en");     // senpai (board, new and review) + speech hints
studyPlanSystemPrompt(variables, "en");       // senpai (plan). Speech hints are not bundled
```

Only `study_plan` omits the speech hints, because those fix **spoken maths**
("さんぶんのに" = 2/3), whereas the numbers in a plan interview are **dates, page
numbers and workbook names** - different things. The listening notes the plan side
needs are written directly in `study_plan.<locale>.md`.

Unsupported languages fall back to `ja` silently (throwing here would stop
conversations the moment a language was added).

## Front matter

Each file starts with the list of variables it embeds.

```yaml
---
id: senpai_conversation
locale: ja
model_role: conversation
variables: [photo_summary, visible_work, allowed_topics, question_seeds, lesson_recap, remaining_seconds]
---
```

`renderPrompt()` errors on a variable not declared in `variables`, and also detects
unexpanded `{{...}}` left in the body (an unfilled prompt blank leads straight to the
LLM going out of scope).

**Keep `variables` identical across locales for the same id.** Drift makes
`renderPrompt` fail in one language only (= conversations never start in that
language). A test checks it.

## Rules for writing them

Prompts are specifications. The following are written **twice**, here and in the code
guardrails (`@ai-sensei/guardrail`). Never fix only one side. They are also **written
twice per language** (missing on the English side breaks the promise for overseas
users only).

| # | Promise | |
| --- | --- | --- |
| 1 | ~~never state the answer, the method or the solution~~ -> **teach it, then have them teach it back** | **revised 2026-08-09** |
| 2 | Never touch topics absent from the photo (topic_ids come from the allow-list) | unchanged |
| 3 | No scores or evaluative language | unchanged |
| 4 | Never blame a pass (being unable to explain) | unchanged |

### About the revision to promise 1 (2026-08-09)

The pivot to a tutoring AI **revised only the first promise**
([pivot plan v1](../docs/pivot_plan_v1.md) §0, "a partial amendment to the
constitution"). The other three are untouched. **Reverting to "never give the answer"
without knowing this makes it a different product.**

> **Give the answer. Then have the student teach it back to you.**

How far the revision reaches differs per id. Check which side an id is on before
editing its prompt.

| id | Treatment of promise 1 |
| --- | --- |
| `senpai_board` | **Post-revision.** Teaches both the photographed problem and the review hole - but never stops at teaching; it always reaches the point of having the student explain |
| `senpai_conversation`, `question_types_few_shot` | **Post-revision.** Teaches when the explanation stalls - but **never fills the answer in first**; make them say it first (say it yourself and whether that was a hole is lost forever) |
| `photo_analysis` | **Pre-revision, unchanged.** The analyser's output decides what gets taught, and an answer here fixes a misreading downstream |
| `karte_generation` | Out of scope (no grading, which is promise 3's territory) |
| `study_plan` | Out of scope (a plan is not where teaching happens). What applies is promise 3, "no scores" |

`containsAnswerLeak()` in `@ai-sensei/guardrail` **checks the pre-revision promise 1**
and is **no longer applied** to the teaching senpai (board or conversation); the
agent's calls have been removed. Left on, it would log a leak every time the senpai
explains the stuck point and keep the warning permanently lit.
The board side's double-write counterparts are these instead:

| Written in the prompt | Counterpart in code |
| --- | --- |
| `speech` is at most 120 characters and never reads formulas aloud | `contract`'s `boardSpeechMaxLength` and the LaTeX ban on `speech` |
| The list of usable LaTeX commands | `guardrail`'s `allowedLatexCommands` |
| Japanese goes in a `text` element, not a formula | `guardrail`'s `text_in_math` |
| One step = one line (no `\\`, no multi-line environments) | `contract`'s `tex` regex / `guardrail`'s `row_separator_outside_environment` |
| Split long formulas before the `=` into two steps | **No counterpart in code yet** (plan §3-6b. Until width estimation lands on the Node side in W2, only the prompt upholds this) |

Study plans (`study_plan`) have different counterparts again:

| Written in the prompt | Counterpart in code |
| --- | --- |
| No target scores or completion rates | `contract`'s `studyPlanSchema` (`strict()` leaves nowhere to put them) |
| At most 120 minutes a day / 10-60 minutes an item | `contract`'s `planDayMinutesMax` and `planItemMinutes*` |
| `material` is the **index** of a material we heard about | `contract`'s `material` index and its range check |
| Dates ascend and never pass the test date | `contract`'s `checkPlanShape` |
| `topic_ids` come from the allow-list | The same matching as `guardrail`'s `filterHoleTopicIds()` (**none for plans yet** - see below) |
| A rebuild does not re-ask `intake` | **No counterpart in code.** Only the prompt upholds this |

Teach-back (`senpai_conversation`) has a double-write counterpart too, in closing
detection.

| Written in the prompt | Counterpart in code |
| --- | --- |
| To close, end explicitly with "**今日は**ここまでにしよっか" / "Let's stop here for today" (never with a phrase that merely marks a break, like "説明はここまで") | `CLOSING_PATTERNS` in `backend/agent/src/closing.ts`, which requires a preceding word scoping the whole day ("今日は", "そろそろ"). Changing the wording means updating the detection and its tests |
| No grading, never pronounce "right / wrong" | **None.** Only the prompt upholds it |
| No orders, no nagging, no numbers (promise 4) | **None.** As above |
| Never fill the answer in first (make them say it) | **None.** `containsAnswerLeak()` cannot be applied (see below) |

"Never fill the answer in first" has no mechanical counterpart because **it cannot be
judged from wording**. The same sentence "the answer is that they intersect at two
points" is correct after the student has explained and a violation before. What the
judgement needs is **turn order**, not vocabulary, so `containsAnswerLeak()`'s regex
cannot replace it in principle. Checking this mechanically starts with designing that.

This is a hole **newly opened** by recasting the AI from kouhai to senpai. A kouhai
cannot say "go study", but a senpai can, so loosening this means it will. Do not
weaken it when rewriting.

Inserted fixed phrases are written in the same language as the body
(`(なし)` / `(none)`, `先輩:` / `Senpai:`, board quotes `「」` / `"`).
One Japanese line mixed in makes that part come back in Japanese.
