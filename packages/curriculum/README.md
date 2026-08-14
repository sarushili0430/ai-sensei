# @ai-sensei/curriculum

The curriculum map.
**The complete set of topics the AI may touch**, and at the same time the vocabulary
for tagging holes.

There is **one per curriculum (track)** ([ADR 0005](../../docs/adr.md#adr-0005) /
[ADR 0007](../../docs/adr.md#adr-0007)).
An English translation of the Japanese curriculum is nobody's curriculum, so it is not
made.

| track | File | Curriculum | Topics |
| --- | --- | --- | --- |
| `hs_math_ja` | `data/curriculum.v0.json` | Math I / A / II / B / III / C (current guidelines) | 52 |
| `hs_math_en` | `data/curriculum.intl.v0.json` | Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics | 57 |
| `jhs_math_ja` | `data/curriculum.jhs-math.v0.json` | Middle-school maths (years 1-3 x numbers and expressions / geometry / functions / data) | 27 |
| `jhs_english_ja` | `data/curriculum.jhs-english.v0.json` | Middle-school English (grammar / sentence structure / phonology) | 25 |
| `hs_english_ja` | `data/curriculum.hs-english.v0.json` | English Communication I/II, Logic & Expression I | 32 |

Each track carries `{ locale, subject, stage }` (`tracks` in `src/schema.ts`).

- **`locale` (the language of instruction) is "the language the senpai speaks", not the
  language of what is taught.** The curriculum where Japanese middle-schoolers learn
  English is `locale: "ja"` - the senpai speaks Japanese and notifications arrive in
  Japanese.
- `subject` decides which board elements are usable and which speech-correction hints
  are bundled.
- `stage` narrows which curricula get pasted into a prompt.

The data itself is plain JSON, readable from outside TypeScript too (Flutter, a Python
agent). `src/` holds the read helpers and the integrity checks. **Only the JSON is
edited to change data.**

## Usage

```ts
import {
  isKnownTopicId,
  localeOfTopicId,
  prerequisitesOf,
  suggestTopics,
  topicLabel,
  topicsForTracks,
  tracksForStage,
} from "@ai-sensei/curriculum";

// Server guard: is the topic_id the LLM returned in the curriculum (across all of them)
isKnownTopicId("M2-ZUKEI-ENCHOKU"); // true
isKnownTopicId("A2-COORD-CIRCLE");  // true

// Find candidate units from photo-analysis text (narrowed by curriculum)
suggestTopics("distance from the center to the line", 5, { tracks: ["hs_math_en"] });

// Digging into a hole: where "what is a discriminant even for?" should go
prerequisitesOf("M2-ZUKEI-ENCHOKU"); // -> [M1-NIJI-HANBETSU, M2-ZUKEI-TENTO-KYORI]

// Always narrow by curriculum when listing for a prompt or a screen
topicsForTracks(tracksForStage("high_school", "ja"));

// A hole's language follows from its topic_id (notifications and the review screen use this)
localeOfTopicId("A1-QUAD-SOLVE"); // "en"

// The short label for chips and the plan screen
topicLabel(findTopic("M2-ZUKEI-ENCHOKU")!); // "数学II"
```

`topics` / `findTopic` / `isKnownTopicId` look **across every curriculum**. Ids never
collide between curricula, so guardrail matching can ignore which one it is.
Conversely, **narrow with `topicsForTracks` when showing a list to a human or an LLM**.
Mixed, an English notebook gets a "Math II / coordinate geometry" chip.

There is **deliberately no function returning "every curriculum in that language"**,
because the day a curriculum is added the prompt would silently double. Use it together
with `tracksForStage(stage, locale)`.

## Adding a topic

```jsonc
{
  "id": "M2-ZUKEI-ENCHOKU",       // {course prefix}-{unit}-{topic}, uppercase romaji
  "course": "数学II",              // CI fails if it disagrees with the prefix
  "unit": "図形と方程式",
  "topic": "円と直線の位置関係",
  "goals": [                       // source material for questions; at least one must ask for an explanation
    "中心と直線の距離dと半径rの比較で位置関係を判定できる",
    "2つの方法の使い分けの理由を説明できる"
  ],
  "prerequisites": ["M1-NIJI-HANBETSU"],  // where digging goes. An existing id **in the same language and subject**
  "keywords": ["円の方程式", "判別式"]     // for matching against photo-analysis text
}
```

Overseas curricula use the same shape. Prefixes are `A1` (Algebra 1), `GE` (Geometry),
`A2` (Algebra 2), `PC` (Precalculus), `CL` (Calculus) and `ST` (Statistics).

```jsonc
{
  "id": "A2-COORD-CIRCLE",
  "course": "Algebra 2",
  "unit": "Coordinate Geometry",
  "topic": "Lines and circles",
  "goals": [
    "Decide how a line and a circle meet by comparing the centre-to-line distance with the radius",
    "Explain why you would choose one of the two methods over the other"
  ],
  "prerequisites": ["A1-QUAD-SOLVE", "A2-COORD-DISTANCE"],
  "keywords": ["equation of a circle", "tangent line", "discriminant"]
}
```

### `grade_hint` (English curricula only)

A rough grade. **Used for display labels only, never for scope decisions.**

The national guidelines **do not allocate middle-school English grammar by grade**
(appendix 7 of the commentary presents it for "middle school" as a whole and states in
the body that allocation is each school's and publisher's discretion).
"be-verbs in year 7" is a textbook convention, so narrowing the scope by it would erase
units for students using a different textbook.

`topicLabel()` is the only thing allowed to read it. That `suggestTopics` /
`resolveDetectedTopics` have **no parameter for a grade** is what makes this promise
real. It is not written for middle-school maths, where the grade follows from the
course itself (`course` is "中学1年 数学") - writing it makes `checkIntegrity` fail.

## Adding a curriculum

1. Add the id to `trackIds` in `src/schema.ts`
2. Write `{ locale, subject, stage }` into `tracks` in the same file
3. Add the course name to `jaCourseNames` and friends, and the prefix to
   `courseCodeByName` / `trackByCourseCode`
4. Add the usable course names to `courseNamesByTrack`
5. Add the JSON under `data/` and register it in `curricula` in `src/index.ts`
6. **Add the prefix to `topicIdSchema`'s regex in `packages/contract/src/karte.ts`**
   (contract is a dependency-free layer, hence the duplicate definition. Forget it and
   new ids are rejected on shape)
7. **Add a branch to `planSubject()` in `apps/mobile/lib/src/l10n/strings.dart`**
   (`apps/mobile/test/curriculum_label_test.dart` catches an omission)

Since `curricula` is a `Record<TrackId, Curriculum>`, adding an id in step 1 and
forgetting step 5 **fails type checking**.

The checks run inside `pnpm test`:

- The schema (zod) - unknown fields are rejected by `strict()`
- Duplicate ids / undefined prerequisites / self-references / cycles (**across every
  curriculum**)
- The id prefix matching `course`, the prefix matching the file's `track`, and `course`
  matching that curriculum
- **Prerequisite references crossing a language or a subject** - an Algebra 2
  prerequisite must not be Math II. Crossing stages (middle -> high school) is allowed
- `grade_hint` appearing only in English curricula
- No course declared with zero topics
- **The current guidelines' allocation** (`hs_math_ja`) - vectors in Math C, statistical
  inference in Math B, hypothesis testing in Math I (adding from the old guidelines
  fails here)
- **Course names that are translations** (`hs_math_en`) - names like "Math II" are
  rejected

## v0's scope

Learning goals must not stop at skills ("can factorise" / "Factor by pattern"): **every
topic carries at least one goal that asks for an explanation** ("can explain why ..." /
"Explain why ..."). This app measures explanation rather than correctness, so a thin
set here makes the questions amount to "can you solve it?". A test checks every topic.

`hs_math_ja` covers Math I and II's frequent units in depth, with 1-3 topics for the
main units of A/B/III/C. `hs_math_en` runs Algebra 1 -> Calculus as the main line with
Statistics alongside; things treated differently by country or school, such as matrices
and series expansions, are absent in v0.

`jhs_math_ja` is 27 entries split by year across the guidelines' domains (A numbers and
expressions / B geometry / C functions / D data). `jhs_english_ja` is 25 entries drawn
from appendix 7 "foreign language materials" (grammar and sentence structure), where
**the year exists only in `grade_hint`, which is display-only**.

`hs_english_ja` is 32 entries from "five skill areas x forms of logic" (the commentary
body) plus appendix 9's eight grammar items (infinitives / relative pronouns / relative
adverbs / conjunctions / modals / prepositions / tense and aspect / subjunctive).
**Appendix 9's high-school column lists only what is handled in addition to the
middle-school materials**, so the seven items overlapping middle school are not
duplicated; `prerequisites` points at middle-school English (`JE-*`) instead (only
relative adverbs are absent from middle school).

### Writing keywords (English curricula)

**Never include a single common English word.** An English notebook always contains
`is`, `for` and `when`, so a keyword like that puts its topic on top every time.
Use Japanese grammatical terms mainly, and for English only phrases of two or more
words (`have been`, `in front of`) or words specific to that grammar (`whose`, `than`).

Even so, keywords work less well for English than for maths (a notebook does not say
"to-infinitive"; it contains English sentences). That is why **`fallback_topic_id`
exists, on the assumption that keywords will miss**.

To expand: draft with an LLM -> human review -> append to the JSON -> `pnpm test`.
