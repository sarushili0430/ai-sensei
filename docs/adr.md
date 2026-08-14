# Architecture decision records (ADR)

One line per decision and its reason. No long narratives.
Superseded decisions are not deleted but **struck through with a date**.

---

<a id="adr-0001"></a>

## 0001 Monorepo + pnpm workspaces

Accepted 2026-08-03

- `apps/mobile` / `backend/*` / `packages/*` live in a single repository
- The TypeScript side is bundled with pnpm workspaces; `apps/mobile` is outside it
- pnpm was chosen because it structurally prevents phantom dependencies
- The package scope is `@ai-sensei/*`. The product name is unsettled, so it is not baked in
- No cross-language type sharing. `packages/contract`'s schemas and fixtures are authoritative
- The same fixture is parsed by both freezed and zod, so contract drift fails in CI
- The curriculum is plain JSON (`packages/curriculum`), read language-neutrally by three runtimes
- The top-level layout is **deployment units**: a path uniquely determines where it goes

**Cost** — schemas are duplicated in Dart and TS. Fixture validation covers it.

---

<a id="adr-0002"></a>

## 0002 The agent is TypeScript (Node 22)

Accepted 2026-08-03

- Guardrails, prompts and the contract can be **one implementation** across api and agent
- Python would mean two implementations, and in solo development one always rots
- `.ts` runs directly with type stripping. There is no build step
- The LiveKit Agents SDK has few precedents, so it is pinned at `^1.6.1` and followed
- Hosted on LiveKit Cloud. `prewarm` connectivity is read from `GET :8081/` returning 200
- **The Dockerfile lives at the repository root.** `lk` uses the working directory as
  the build context, and `workspace:*` only resolves from the root

**Rejected** — handing over a baked image (`--image` is Enterprise-only) /
splitting `backend/agent` into its own repository (which would erase the reason for one
implementation).

---

<a id="adr-0003"></a>

## 0003 `/complete`'s internal auth stays a shared static token

Accepted 2026-08-04

- Left as-is until the MVP submission. The rebuild happens once, after the agent's host is settled
- The value never reaches a client; it is server-to-server only
- `INTERNAL_API_TOKEN` is **a different value per environment** and is never logged
- The target shape is a short-lived session-scoped token (with `sub`/`aud`/`exp`)
- Workers alone holds the signing key; the agent holds no long-lived key
- The parts are covered by `lib/livekit.ts`'s HS256 implementation. No new dependency

**Rejected** — putting it in the LiveKit token's `metadata`. That JWT is returned to the
app verbatim and readable by base64 decode, so the app could forge a karte.

**Revisit when** — after submission in W4 / when the agent's host is settled / when
someone other than me touches the agent's runtime.

**Residual risk** — a leak of the agent's runtime allows forging every session's karte.

---

<a id="adr-0003-voice"></a>

## 0003 Voice consolidated on Deepgram (STT + TTS)

Accepted 2026-08-06

- Aura-2 gained Japanese support, removing the technical reason to split across two vendors
- One failure point, one key, one bill. That matters a lot in solo operation
- Swapping it is one block in `agent.ts`, so it is **reversible**
- The voice is the character. `aura-2-izanami-ja` is fixed and never varies per environment
- English uses a different model (`DEEPGRAM_TTS_MODEL_EN`); Deepgram bakes the language into the model name
- Settings with defaults **treat an empty string as unset** (empty breaks in the "only the voice is missing" way)

**Cost** — losing the ElevenLabs sponsorship tie-in (a partnership decision, not a
technical one). The SDK's `TTSModels` type enumerates only English voices, so voice
names are not protected by types.

---

<a id="adr-0004"></a>

## 0004 Motion goes through one path, with one round trip in onboarding

Accepted 2026-08-06

- Decorative motion always goes through `AppMotion`. With reduce-motion on, it **is not shown**
- When not shown, draw the **finished** state. Stopping at 0 looks broken
- The exception is interaction time (`AppDurations.hold`); a long press's length is a metaphor for the explanation, so it is not shortened
- While reading aloud (`prefersTapOverHold`), long press switches to tap
- Tests always run with `disableAnimations`. A loop that forgot the path makes the test never return, which exposes it
- The highlighter marker is drawn **per line**, from the top down
- Onboarding is four screens. The third is a rehearsal (no photo, no voice, no permissions)
- Explaining and passing both move forward. "Skip" appears from the third screen, so there is no dead end

**Rejected** — moving to Rive (v1.1) / sound effects / making them test the microphone
during onboarding / making the rehearsal mandatory.

**Addendum 2026-08-11** — the pivot revised promise 1 to "teach, then have them teach it
back", and the third screen was replaced with "be taught on the senpai's board, then
teach it back". Lines 1, 2 and 4 above still hold.

---

<a id="adr-0005"></a>

## 0005 English support is not translation; each curriculum is separate

Accepted 2026-08-07

- One curriculum file per locale. `ja` is Math I-C, `en` is Algebra 1 through Statistics
- No mapping table. Where they diverge you get **a unit belonging to neither curriculum**
- The locale follows from the topic_id prefix (`M1`-`MC` / `A1`, `GE`, `A2`, `PC`, `CL`, `ST`)
- Because a hole's language follows from its topic_id, the session's locale need not be stored in the DB
- Prompts are **separate books**, `prompts/<id>.<locale>.md`. Never append "answer in English" to a Japanese body
- Fixed phrases and role labels match the body's language too. One mixed line makes that part revert
- Guardrails are per language. Out-of-scope words differ by curriculum (L'Hôpital is out of scope in Japan and covered in AP)
- Device language means "Japanese only for those who asked for Japanese"; everything else falls to English

**Rejected** — translating the Japanese curriculum / storing the locale on the DB's
session row / putting both curricula in one file.

---

<a id="adr-0006"></a>

## 0006 Fold away the study room; the core is the inside of the core loop

Accepted 2026-08-11

- **The study-room mode is removed.** It spent attention rather than money
- Its only way forward was taking a photo, the same destination as home
- Time spent could not be returned to the student under promise 2, and was a number that never appeared on screen
- It nonetheless cost one permanent tab and one D1 table
- One turn of the core = photograph -> be taught with a board -> teach it back -> karte -> quiz -> review after 1/3/7 days
- Study plans, the parent report, billing and onboarding stay, because arrows point at them
- **The board moves into the karte**, making it the only place it can be re-read beyond the lesson's lifetime
- The karte reads conclusion (what was said, the holes) -> evidence (the board) -> actions
- **The board is not put in a card.** The effective width drops from 345pt to 311pt and formulas scroll horizontally
- Home always has exactly one primary action. They are **swapped**, never listed together
- On a day with a lesson available: "be taught by the senpai". On a day already closed: "holes to fill" (review, free)
- On a closed day the greeting turns to appreciation. A screen that will not let you photograph must not prompt for a photo
- Three permanent tabs: home / plan / settings. The karte is not a tab
- `study_room_daily` is dropped in `0007`; `0006`'s file stays for already-migrated DBs
- Store screenshots are taken **through the shell**; without the bottom tabs they differ from the real device

**Rejected** — moving it off the tabs as a detour (the problem was not its location) /
showing time spent in progress (breaks promise 2) / giving the study room exercises
(breaks zero marginal cost).

---

<a id="adr-0007"></a>

## 0007 Separate the curriculum (track) from the language of instruction

Accepted 2026-08-12

- [0005](#adr-0005)'s "locale" served three roles at once: which curriculum, the language
  the senpai speaks, and the guardrails' vocabulary
- "A Japanese middle-schooler learning English" = **an English curriculum with Japanese
  instruction**, which one value cannot express
- `CurriculumLocale` (`ja`/`en`) **stays the language of instruction**; the curriculum is
  split out into `TrackId`
- `Record<CurriculumLocale, …>` and `plan_sessions.locale`'s CHECK are untouched, and
  stored topic_ids are unchanged, so **there is no migration**
- What a prefix yields is now two steps: prefix -> curriculum -> (language, subject,
  school stage). [0005](#adr-0005)'s "one id determines the language" survives, stronger
- One track = one JSON file. `Record<TrackId, Curriculum>` makes a missing registration
  fail type checking
- **`topicsFor(locale)` was deleted.** Kept, the prompt would silently double the day a
  curriculum was added
- The year is isolated in the display-only `grade_hint`. That `suggestTopics` /
  `resolveDetectedTopics` have **no parameter for a year** is what makes "never narrow by
  year" real
- The guidelines do not allocate middle-school English grammar by year (appendix 7 covers
  "middle school" as a whole). Middle-school English course codes are not per-year for
  the same reason
- Prerequisite references were loosened from "the same curriculum" to **"the same
  language and the same subject"**. Taking a year-11 student back to year 9 is the
  senpai's core function, so stages may be crossed
- `school_stage` arrives per request and is not stored in the DB. The default is
  `high_school`
- Usable board elements are closed by subject (maths = formula types / English =
  `sentence`, `compare`). English curricula never reach the LaTeX checks
- High-school English grammar is appendix 9's eight items. Only relative adverbs are
  absent from middle school, so the other seven are not duplicated and point at
  middle-school English via `prerequisites`

**Cost** — prefixes remain duplicated in three places (`curriculum/schema.ts`,
`contract/karte.ts`'s regex, mobile's `planSubject`). It cannot be untangled while
contract stays a dependency-free layer, so it is bound by **a test that no course code
falls back to the default**. `school_stage` must be chosen again after a reinstall.

**Rejected** — adding `"ja-english"` to `CurriculumLocale` (the `Record`'s meaning would
shift from "per language" to "per curriculum", and the CHECK constraint would need
rewriting) / rebuilding topic_id as `{subject}-{curriculum}-{unit}` (every stored id
would have to be rewritten) / putting the year into the course code (it would promote an
allocation the guidelines never set into a specification).
