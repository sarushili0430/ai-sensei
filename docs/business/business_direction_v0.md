# Business direction memo v0 — the route from Katarute to "the book"

Written 2026-08-05 / Status: a discussion draft on business direction
(**the development scope up to 9/30 does not change at all**)
Background: [`inception-deck.md`](../inception-deck.md)

This document answers two pivot proposals: "position it as an education app" and "an
environment where you can ask questions of a PDF". Conclusions first, reasoning after.
It does not move the inception deck's "won't do" list — that decision waits until the
Shipaton numbers are in (§7).

---

## 0. Conclusions first

1. **This is not a pivot.** "Notes", "PDF" and "the book" are the same core loop
   (content -> the AI asks -> you explain -> the gaps stay in a karte -> revisited at
   intervals) with **a different content source**. What is being built now is a scale
   model of the north star (the book), and almost nothing gets thrown away.
2. **The direction of proposal 2 is right, but it must not become "an app where you can
   ask questions of a PDF".** That is a commodity ChatGPT and NotebookLM already do for
   free. What must be protected is the reversal of direction — **the AI is the one
   asking**. The differentiation is the same four promises as today (never give the
   answer, no scores, never shame a pass, never nag).
3. **The UI metaphor is a "bookshelf", not a "project".** The mechanism can be the same
   as Claude Projects (a container of content with conversations and kartes attached).
   But if the north star is the book, "uploading = one more book on the shelf" is more
   consistent, and the demo shown to publishers is then already finished.
4. **Covering every subject is not needed now.** That is a requirement for "winning the
   education-app market", not for the north-star PoC. And adding a subject is content
   production — building curriculum maps — whose **investment direction is opposite** to
   the technology the book vision needs (getting question quality with no structured
   data). The exception is Japanese (reading comprehension), which is the bridge to the
   book itself (§3).
5. **The PoC is redefined in three stages, by hypothesis (§2).**
   H1: does the experience of being made to explain retain? (being validated by the
   current app). H2: can good questions be built from arbitrary text with no curriculum
   map? (validated by the PDF version). H3: will publishers release their data?
   (validated in negotiations, not in a product).
6. **The UI/UX core does not change; the entrance and the karte's unit do (§5).**
   Today's "photograph -> conversation -> karte" is close to optimal for the maths PoC's
   purpose, and the freeze holds until 9/30. In the book/PDF version the entrance becomes
   "how far did you read?" and the karte grows from a per-session record into
   "an understanding map per book".

---

## 1. How the three proposals relate — one engine, different content sources

```
           Content source              Target
Current    Notes photos (maths)        High-schoolers      <- validating H1 (Shipaton)
Proposal 2 PDFs and documents you bring High-schoolers to adults  <- the way to validate H2
North star Publisher-licensed books    Readers generally   <- stands up once H1 x H2 x H3 hold
```

The core engine is shared by all three:

1. Ingest content and build the "allowed scope" of what may be asked about
2. The AI asks and the user explains in their own words
3. Where they stall stays in a karte as a "gap in understanding"
4. Revisit after 1, 3 and 7 days

The original motivation was "I say I read a certain page and the AI asks the right
questions to deepen my understanding". The current app just replaces "page" with "today's
notes", so **it already has the same structure as the north star**. So the question is not
"should we pivot" but "in what order do we widen the content sources".

---

## 2. Working back from the north star — only three things to prove

| # | Hypothesis | How to validate | Status |
| --- | --- | --- | --- |
| H1 (experience) | Does "being made to explain to an AI" have retaining value | The current app's W5-7 numbers (retention, conversation completion, gap revisit rate) | In progress |
| H2 (technology) | Without a curriculum map as scaffolding, can "good questions that do not give the answer" be built from arbitrary text | A minimal PDF implementation | Not started. **The book vision's technical core** |
| H3 (business) | Will publishers release book data, and in exchange for what | Negotiations (no product needed; start with a proposal deck) | Not started |

The important thing is that **covering every subject is needed by none of these
hypotheses**.

### Why H2 is the technical core

Today's question quality is protected by two guardrails: "what is in the photo ∩ the
curriculum map", plus `topic_id` allow-list matching. In other words, **hand-built
structured data is the foundation of quality**.

Books and PDFs have no such foundation - only a contents page and body text. Whether
question quality survives that is the question. If it does not, the book vision does not
stand; if it does, cross-subject coverage arrives for free without building per-subject
curricula. So PoC 2's essence is not the UI but validating **the generalisation of the
guardrails** (from a hand-built curriculum map to a chapter/chunk structure derived
automatically from a document).

---

## 3. Proposal 1 (an education app) — why not to cover every subject now

"If we position it as an educational app, don't we need subjects beyond maths?" is best
answered by **separating the positioning problem from the building problem**.

- **The positioning is fine as it is.** A one-liner limited to "maths" is designed to land
  in the store (inception deck §0). There is no need to sit on the same shelf as
  all-subject services. A strong single-subject app is normal in education (mikan for
  English vocabulary, Photomath for maths).
- **Chasing every subject on the building side points the investment away from the north
  star.** Adding a subject means building a curriculum map, question templates and a
  spoken-correction dictionary per subject, which reinforces an architecture that
  **cannot ask questions without structured data**. Building atama+-style per-subject
  knowledge graphs is company-sized work, not something one person chases.
- **The exception is Japanese (modern texts and criticism).** "Read a passage and explain
  its content in your own words" is a miniature of the book vision itself, and the
  questions come from **the text's structure** rather than a curriculum map. So Japanese
  support doubles as H2's validation. If a subject is added, add this one first — but not
  before October.

The fork, stated explicitly:

| Route | What it needs | Competitors | Relation to the north star |
| --- | --- | --- | --- |
| Winning as an education app | Every subject, exam context, B2B for cram schools and schools | Studysapuri, atama+, Monoxer | A detour (it optimises for the education market) |
| The book vision's PoC | Maths plus (as the next move) Japanese | This position is open | A straight line |

Neither has to be chosen now, but remember: feeling "we have to do every subject" is the
signal of being pulled towards the former.

### 3-2. Addendum (2026-08-06): the framing of "one daily study review"

> **-> Rejected the same day (§3-3).** A usage cap damages the experience.
> The route changed from a cap to "make the session lighter to cut unit cost, and recover
> it through pricing". Kept below as a record of the discussion.

> Proposal: leaning the education-app direction towards "doing a study review" would
> naturally limit usage to once a day (about three times for people who want more).

**Conclusion: agreed. But this is not a change of direction so much as a change in what
"once a day" means, and the features are already almost there. The change is cheap, with
three benefits.**

#### What is good about it

1. **It closes Premium's unbounded cost (the most practical benefit).**
   Conversation cost is metered (a few to a dozen-odd yen a minute across STT+LLM+TTS),
   yet the current implementation is Free = once a day for 5 minutes against
   **Premium = unlimited sessions** (`backend/api/src/lib/entitlement.ts`: there is a cap
   on a single session's length but none on the count). The structural risk that one heavy
   user's monthly cost exceeds their subscription remains as deck §7-4's concern.
   In a worldview where "a review is something you do at the end of the day",
   **Premium = three a day** can be placed as "the grammar of a daily habit" rather than
   "a limit". A flat subscription over metered cost needs a ceiling somewhere — and being
   able to place it **without looking stingy** is this framing's greatest value.
2. **"Once a day" turns from a negative (a free-tier limit) into a positive (a habit).**
   Today's once a day reads as "put up with it, it's free". Under the review framing it
   reads as "that's the kind of app it is". It meshes directly with writing notifications
   and paywalls as a request from the AI (deck §0's promise 4, "never nag") and with
   HAMM's honest-paywall criteria. Premium's pitch also stands honestly as "up to three a
   day before a test, plus unlimited gap review" rather than "unlimited".
3. **It provides a habit grammar and becomes isomorphic to the north star.**
   The trigger moves from "just after writing notes" to a fixed time, "the end of the
   day", closing the habit loop with a nightly notification ("could I hear about today's
   study?") -> explanation -> streak. The OneSignal award's story (1/3/7-day reviews plus a
   nightly habit) gets stronger too. And it becomes **exactly the same grammar** as the
   book/PDF version's entrance, "how far did you read today?" (§4-2) — this change points
   towards the north star.

#### What to watch

- **If "review" drifts into "talk about today's log", the differentiation dissolves.**
  A metacognitive diary of "what did you study today, how did it go?" is covered by
  Studyplus or ChatGPT. The core remains **making them explain the content**
  (self-explanation). The review is the frequency and the entrance's grammar; the
  conversation's substance must stay "wait, why do you use the discriminant here?".
  Photographing notes stays too, since it is the foundation of the question guardrails
  (the review's entrance = photographing, unchanged).
- **Do not let them cram everything into one session.** Not "everything you did today"
  but "the one thing you are least sure about", chosen by them or with the AI's help.
  The 5-minute session budget holds, the act of choosing is itself metacognition, and the
  karte gets richer.

#### What to change during Shipaton (proposal)

| Change | Content | Cost |
| --- | --- | --- |
| A Premium count cap | Add premiumSessionsPerDay (=3) to `entitlement.ts` | Small. It is cost insurance addressing deck §7-4, so it does not conflict with the freeze |
| Re-telling the wording | Move onboarding, the paywall and the store description towards "a once-a-day habit" | Small. Absorbed by W4's polish |
| A nightly habit notification | Add one "could I hear about today's study?" | Medium. A feature addition, so only if it can ride along with W3's notification work |

Deck §0's one-liner is **not changed**. "A once-a-day habit" does not contradict it and
is a story that can be layered on top, so no constitutional amendment is needed.
Whether to re-badge the whole thing as a "review app" is decided together with October's
H1 verdict.

### 3-3. Addendum (2026-08-06): the count cap rejected — towards "light sessions plus pricing"

> Decision: §3-2's "Premium = three a day" damages the experience and is not adopted.
> Instead, (1) make the session itself lighter to cut cost, and (2) recover it through
> pricing (800 yen weekly / 2,000 monthly / 20,000 annually).
> The flow moves towards "photograph the notes you are least sure about -> the user
> explains first -> a light session with the AI -> karte generation".

#### Assessment: agreed. The "explanation first" flow *is* the biggest cost reduction

- **TTS (how much the AI speaks) dominates conversation cost.** Changing "five minutes of
  the AI interviewing" into "three minutes where the user explains first and the AI
  listens with one or two follow-ups" structurally reduces both the minutes and the TTS
  character count. **One move that is both an experience change and a cost reduction**,
  removing the need for an external cap like §3-2's - that is this route's core.
- **It is purer in learning-science terms.** The self-explanation effect's core is
  "generating an explanation yourself first", so putting explanation before answering
  questions is truer to the principle. The protégé effect's role relation ("the teacher is
  the user") also gets clearer.
- **It also helps W2's Go/No-Go gate.** Fewer turn-taking round trips means less exposure
  to latency, barge-in and misrecognition. A light session is a light technical risk too.

Practical levers around STT/TTS:

| Lever | Content | Effect |
| --- | --- | --- |
| Pre-rendered backchannels | Pre-generate "mhm", "oh!", "I see..." as audio assets, dropping TTS calls to zero. In a listening flow, backchannels are most of the speech | Large (latency disappears too) |
| A TTS cache for fixed lines | The opening, the closing and the celebration are reused across sessions | Medium |
| Choosing TTS models | A cheap Flash-class model for ordinary speech, a high-quality one only for the emotional celebration | Medium |
| LLM prompt caching | The system prompt and few-shot examples are identical every turn, so caching works. The "at most two sentences per utterance" character design also keeps output tokens down | Medium |
| A 3-minute session target | "Light", made explicit. Fewer minutes reduces everything | Large |

#### Notes on the pricing (800 weekly / 2,000 monthly / 20,000 annually)

- As a shelf position: the same band as Studysapuri Basic (2,178 yen a month). Bold for a
  single subject, but viable if used as "a daily companion". **The weekly 800 yen should
  be the lead** - a high-schooler's wallet suits a one-off "just before the test" purchase
  more than a monthly contract, and that matches the spikes in usage.
- 20,000 a year is 17% off the monthly rate, shallower than a typical annual discount
  (50-70% of monthly x 12). But **discounting an annual plan deeply is dangerous for a
  product with metered cost**, so the shallowness is rational. Consider writing it as
  19,800. The annual buyer is assumed to be the parent, not the student (exam year).
- Implementation cost is zero. RevenueCat is already set up with the three slots
  `$rc_weekly / $rc_monthly / $rc_annual` ([`../revenuecat.md`](../revenuecat.md)), and
  pricing is done entirely in App Store Connect and the dashboard.
- One piece of insurance only: **a fair-use cap that is never surfaced** (say 30 minutes a
  day in total, written into the terms and never mentioned in the UI). It is different
  from §3-2's "cap as a habit" - it is a valve for anomalies, set where an ordinary user
  never reaches it.
- Unit economics, roughly: a light 3-minute session x 5-15 yen a minute = 15-45 yen a
  session. Recovering 2,000 yen a month needs 44-130 sessions a month, which one or two
  real sessions a day comfortably covers.

#### Flow design: starting from "what you are least sure about"

Photograph -> **choose "what are you least sure about?"** -> the AI asks "so what kind of
problem was this?" -> the user explains (60-120 seconds while the AI listens with
backchannels) -> one or two follow-ups -> celebration -> karte.

- "Taking notes on what you are unsure about" connects directly to the mistake-notebook
  and weak-points-notebook culture (a staple of study accounts). It works as growth
  vocabulary too.
- One caveat: **the gaps in an illusion of understanding are where the person does not
  think they are unsure** (that is this app's premise). Leaving it entirely to the user's
  self-selection misses the unknown unknowns, so keep a design where one follow-up comes
  from the AI's own seeds (question_seeds), aimed at the range they did not choose.

#### An answer to "the AI does not understand the problem"

The worry is correct. But this product has two structural escape hatches an ordinary AI
tutor does not, **both already implemented**:

> **[Point 1 of this section lapsed with the 2026-08-09 pivot]**
> The role changed from kouhai to senpai, and `prompts/kohai_conversation.{ja,en}.md` was
> replaced by `senpai_conversation.{ja,en}.md` (the link below no longer resolves).
> The countermeasure against misreading changed from "cast the AI as the side that does
> not understand" to "**teach, then have them teach it back, so the user's explanation
> falling apart surfaces the misreading**"
> ([`pivot_plan_v1.md` §1](../pivot_plan_v1.md)). Point 2 still holds.
> **This section is kept as a record of the decision at the time.**

1. **The AI is cast as the side that does not understand.**
   `prompts/kohai_conversation.ja.md` (now `senpai_conversation.ja.md`) says "I don't
   really understand yet", "do not correct them even if they are wrong", "use no
   evaluative language". If the AI misreads the problem, a naive off-target question from
   a kouhai is **inside the character**, and breaks differently from a teacher asking an
   off-target question. Misreading is fatal in apps built on "the AI understands".
2. **The karte is designed not to assert mathematical correctness.**
   [`prompts/karte_generation.ja.md`](../../prompts/karte_generation.ja.md) records only
   "where the explanation stalled", quoting the student's own words (evidence). It never
   asserts "they do not understand", and arithmetic slips do not become gaps. The karte's
   correctness is grounded in the transcript as observed fact and **does not depend on
   whether the AI can solve the problem**.

The remaining gap is grounding at the entrance: notes often do not contain the problem
statement, and a misreading by photo_analysis skews question_seeds. Three countermeasures:

- **Make the standard opening question "so what kind of problem was this?"**
  Having the user restate the problem in their own words means (a) the problem statement
  reaches the AI (grounding), (b) whether they can restate it is itself the first
  diagnosis (many students cannot state what a problem asks), and (c) it is completely
  natural for the character. **A weakness converts directly into the first question.**
- A hint on the capture screen: "capture the problem statement too and the AI won't get lost".
- Reusing the unit-chip confirmation UI so the summary of the problem read from the photo
  can be confirmed and corrected (optional).

What must not be done is solving this worry by "making the AI smarter so it can judge
correctness". The moment it judges correctness, a misread becomes fatal and the "no
scores" promise breaks too. **A character that admits it does not understand, plus a
karte made only of observed fact**, is the insurance against misreading.

This problem and its answer generalise directly to the book/PDF version (§4): against
"the AI has not read the whole book", the same stance works — "have the user say how far
they read and what it was about", plus "the karte is an observation record of the
explanation". Include that lens in H2's validation design.

#### Try it yourself first (added the same day)

Pricing and flow can only be worked out on paper so far. Assuming the direction is sound,
the next inputs for both profitability and the user's view come from running it yourself:

- **H0 (developer dogfooding)**: before H1 (real-user retention), run one session a day
  for a week or two yourself. Watch three things — "does explaining feel good", "are the
  questions off-target (how often does misreading occur)", "does the karte feel accurate".
  This is also the input to W2's Go/No-Go gate.
- **Per-session cost telemetry**: log STT seconds, LLM tokens, TTS characters and an
  estimated cost per session. Every dogfooding session then doubles as real profitability
  data. Replace §3-3's paper figure of "15-45 yen a session" with measurements before
  finalising the price.

---

## 4. Proposal 2 (PDFs and documents you bring) — agreed, with three design principles

### 4-1. Do not break the reversal of direction (most important)

"Upload a PDF and ask questions" is already a free everyday commodity:
ChatGPT / Claude Projects / NotebookLM / Acrobat AI Assistant.
Entering in that direction (the user asks, the AI answers) is unwinnable.

What must be protected is the same **reverse** direction as today — **the AI asks the
user** about the uploaded document. NotebookLM has quiz generation, but that ends as a
generated set of question-and-answer pairs. Here:

1. A dialogue that **makes you explain**, by voice or in text
2. The gaps accumulate as a karte
3. It revisits at intervals
4. There is a character

That set of four does not fall out of a search-style AI tool's design philosophy.
The four promises hold in the PDF version too. The moment they break, it is a commodity.

### 4-2. The metaphor is a bookshelf

A Claude Projects-like mechanism (a content container with conversations attached) is
right. But the name and the look lean towards a **bookshelf**, not a "project":

- Home = a bookshelf. Adding a PDF puts one "book" on it
- Open a book -> the AI asks "how far did you read today?" (a chapter or page range)
- Conversation -> **that book's** karte grows (yellow markers = said it / pink = gaps, per chapter)
- The revisit notification is "could I ask about chapter 3 of that book again?"

Three reasons. (1) The north star is the book, so the demo shown to publishers is already
finished. (2) "Project" is workplace vocabulary and floats away from the study and reading
context. (3) A karte accumulating per book makes the value of reading — "understanding one
book completely" — visible as-is.

### 4-3. Make "finishing one book" the unit of progress

Progress is **an understanding map for one book filling in**, not one-off sessions.
Streak days and the filled-gap counter stay shared, and the long-term reward becomes
"books fully understood" accumulating on the shelf. It also connects naturally to
book-log culture (Dokushometer and the like), where the count of books adds up.

### The technology: a reuse map

| Asset | In the PDF version |
| --- | --- |
| The conversation pipeline (LiveKit / VAD / STT / TTS) | Unchanged |
| Karte generation, spaced repetition (OneSignal), billing (RevenueCat), free-tier metering | Unchanged |
| The persona and the four-question-type few-shot | Almost unchanged (spoken-maths correction becomes unnecessary) |
| Photo analysis (photo_analysis) | **Replaced by PDF ingestion (contents extraction, chapter chunking)** |
| The curriculum map + topic_id matching | **Generalised to an automatically derived chapter/chunk structure plus "is it actually written in that chapter"** <- the core of the new work |

What is genuinely new is only "ingestion and automatic generation of the allowed scope".
Put the other way, PoC 2 can be minimal as long as it validates that.

### Open questions

- **Voice or text.** Reading is a silent-reading culture, so the friction of "explain out
  loud" bites harder than today (inception deck §7-5's concern). A text explanation mode
  rises in priority for the PDF version. The conversation pipeline is shared, so it should
  be designable as an input/output switch.
- **Mobile or web.** PDFs pile up on PCs and tablets. Staying on the Flutter assets, the
  realistic answer is iPad support plus a share sheet ("send to Katarute" from other apps).
- **The target.** The strongest pain around documents you bring is actually not
  high-schoolers but **people studying for qualifications and adults reading technical and
  business books** ("I read it but it did not stick" is explicit, and willingness to pay is
  higher). Whether to stay on the high-schooler brand or widen here is a major fork (§8).

---

## 5. How the UI/UX changes

**The core loop's screens (conversation, celebration, karte, review) do not change. The
entrance and the unit of accumulation do.**

```
Current      home -> capture ------------------> conversation -> celebration -> karte (per session)
Book/PDF     shelf -> open a book -> how far did you read? -> conversation -> celebration -> that book's karte grows (per book)
```

The answer to "is the current UI optimal": **close to optimal for the maths PoC's purpose
(validating H1)**. Photographing is the shortest possible entrance for naming "what I
studied today", and it is hard to imagine a lighter one. Freeze it until 9/30 as the deck
says, and look for reasons to change only once numbers arrive.

The need to change appears when content sources widen, and it appears not as rebuilding
screens but as **one extra layer, the bookshelf, in front of the existing screens**.
Only the karte screen needs to evolve, from "a record of a session" into "an understanding
map for one book" (showing the distribution of gaps per chapter).

---

## 6. How to enter the publishing industry (hypothesis)

Order matters. **"Give us your book data" does not work as an opening move** (piracy
concerns, no precedent, effort on their side).

1. **Build a track record with documents users bring (PoC 2).** No publisher permission is
   needed for users to add their own PDFs and materials. That accumulates data on "readers
   explain a book, understanding deepens, and they come back".
2. **The first counterparts are study-guide and qualification-textbook publishers.**
   Closer than general literature on three counts: (a) the "deepen understanding" need is
   explicit, (b) the current app's track record (high-school maths) is directly usable as
   material, and (c) "photograph a Chart-shiki page and explain it" already happens
   naturally under the current spec. Think Suken, Obunsha, TAC.
3. **What we offer is data the publisher does not have.** A printed book shows nothing
   about the reader after the sale. Completion rate, where readers stumble per chapter and
   revisit rate are primary data that feed revisions and the next title.
   "An official tie-in extends the post-reading experience, and reader data comes back" is
   the backbone of the trade.
4. **Show from the start that full text is not needed.** Question generation needs only
   the chapter structure and the text of the relevant range; there is no copying or
   redistribution of the whole (the reader is assumed to own the book). That design is
   itself the answer to piracy concerns.

A reference point for widening to general books: flier (summaries) is the "before reading"
market; this is the "after reading" market, so they do not compete. The pitch "turn your
unread pile into an understood pile" can be built from here.

---

## 7. Proposed sequencing

| When | What | What moves |
| --- | --- | --- |
| To 9/30 | **Hold the current scope; submit to Shipaton.** Pivot thinking stops at this memo | Nothing moves (deck §4 holds) |
| Early October | H1 verdict: retention, conversation completion, gap revisit rate | Gathering the inputs |
| From October | PoC 2 (bookshelf + documents you bring) at minimum scope: add a book -> pick a chapter -> converse -> karte. **Validate only H2's question quality** | New work is only ingestion and automatic scope generation |
| In parallel | Start informal conversations with one or two study-guide / qualification publishers (shape this memo into a proposal deck) | No product needed |
| From November | Make a formal proposal with H2's result plus H1's numbers. Re-decide whether Japanese (reading comprehension) support is needed | Open a PR revising the "won't do" list |

The growth work from W5 (seeding study-account culture) doubles as PoC 2's customer
development: watching whether "I want to add things other than notes" comes up naturally
makes October's decision easier.

---

## 8. Questions to settle next

1. **Which route**: win as an education app (every subject, the exam market), or accept
   this as the book vision's PoC (maths plus Japanese is enough)? -> This memo argues for
   the latter
2. **PoC 2's target**: stay with high-schoolers, or widen to qualifications and adults
   (brand, price and channel all change)
3. **PoC 2's form**: a new layer inside the current app (a bookshelf tab), or a separate
   app or web
4. **Voice versus text**: does the PDF version keep voice as the main axis, or is text
   explanation made official
5. **H1's pass line**: at what retention and revisit rates do we say "the experience
   works"? **Deciding while staring at the numbers in October will always drift, so decide
   during September**
6. **Finalising the price (§3-3)**: ship at 800 weekly / 2,000 monthly / 20,000 annually?
   (the annual discount's depth, whether to write 19,800). Before finalising, take real
   cost measurements from H0 dogfooding and per-session telemetry
