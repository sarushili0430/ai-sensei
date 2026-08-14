# @ai-sensei/agent

The senpai AI's session (lesson -> teach-back), running on LiveKit Agents (Node).

```
Phase 1 "lesson"     board LLM (Claude) -> LiveKit Text Streams per step -> TTS right after
Phase 2 "teach-back" VAD (Silero) -> STT (Deepgram) -> Claude (senpai persona)
                     -> TTS (Deepgram Aura-2). Barge-in and backchannels are the framework's.
```

**No WebRTC is written here.** Only three things are:

1. Passing the photo context along (LiveKit token metadata -> prompt)
2. Cutting off at the time cap (the server's `max_seconds`)
3. Generating the karte at session end and POSTing to `/complete`

Why TypeScript: [ADR 0002](../docs/adr.md#adr-0002).

## Running it

```bash
cp .env.example .env
pnpm --filter @ai-sensei/agent download-files   # fetch the Silero VAD model
pnpm --filter @ai-sensei/agent dev              # listen for rooms
```

When `backend/api` creates a room via `/v1/sessions`, this worker receives the job.

## Deployment

It runs as a long-lived container. **The Dockerfile is at the repository root**
([`../../Dockerfile`](../../Dockerfile)). Not because `packages/*` is referenced via
`workspace:*` alone, but because `lk agent deploy` only reads a `Dockerfile` directly
inside the working directory (see the addendum to ADR 0002).

```bash
pnpm --filter @ai-sensei/agent run docker:build   # equivalent to docker build . at the repo root
pnpm --filter @ai-sensei/agent run docker:run     # run locally with .env
curl -i http://localhost:8081/                    # 200 means it registered with LiveKit
```

**A health check listens on `0.0.0.0:8081`** (`GET /` returns 200/503, `GET /worker`
reports status). `503` does not mean "down" but "not connected to LiveKit yet".

Where it runs (LiveKit Cloud agent hosting or any container host), how to supply
secrets, and automatic deploys from GitHub Actions are in
[`docs/deploy-agent.md`](../../docs/deploy-agent.md).

## Dispatch (who calls this worker)

How the worker is registered changes how it is called.

| Registration | How it is called | API side |
| --- | --- | --- |
| Unnamed (default) | Auto dispatch. It joins every room in the project | nothing to set |
| Named (`LIVEKIT_AGENT_NAME`) | Explicit dispatch only | the same name in `LIVEKIT_AGENT_NAME` |

**LiveKit Cloud agent hosting sets `LIVEKIT_AGENT_NAME` automatically.**
Deploy there while the API side is empty, and the room is created but no senpai
arrives - the app sits on "listening" (neither conversation nor karte happens).
When there is no `job_started` log, suspect this first.

## The conversation context arrives on the token

`backend/api` puts the photo interpretation, the allowed topics, the question seeds
and the remaining seconds into the LiveKit token's `metadata` as JSON. Passing them on
a separate channel could produce a session whose token and context disagree.

On explicit dispatch, the same JSON also rides the job's metadata.
**Whichever reads first is used**, so the conversation starts even if the dispatch
style changes.

**If the metadata is unreadable, the connection is dropped without starting.**
Speaking without context means teaching generalities unrelated to the photo, so it is
better to end quietly.

## Karte generation

`buildKarte()` does not depend on LiveKit and can be tested on its own.

1. Build the `karte_generation` prompt from the whole transcript, the photo summary and
   the allowed topics
2. Validate the LLM output with `karteDraftSchema` (zod)
3. Match the holes' topic_ids against the allow-list (the server matches too, but this
   rejects before sending)
4. POST to `/v1/sessions/{id}/complete` with the internal token

**No karte is built for a conversation where the user never spoke** (an empty karte is
sent instead). The LLM is never forced to invent holes. An empty karte is not a failure.

## How a conversation ends

Three ways. Which one it was becomes `ended_reason`, used to weight the karte.

| ended_reason | Trigger |
| --- | --- |
| `completed` | The closing line was spoken (`closing.ts` detects it and closes after the playout margin) |
| `timeout` | The server's `max_seconds` was reached |
| `user_left` / `error` | Departure or error |

**Once the conversation ends, the room is closed before karte generation.** Left open,
the user could keep talking during generation (a few seconds) and pass the time cap.
`duration_seconds` is also measured at room close (mixing in generation latency would
record a 5-minute session as 6).

## Locale

`locale` is an API-accepted value, so STT, TTS and the opening greeting follow it.
Feeding English to the Japanese model wrecks recognition and the conversation falls
apart.

**Prompts are separate books per language** too (`prompts/<id>.<locale>.md`).
Appending "answer in English" to a Japanese body was abandoned
([ADR 0005](../../docs/adr.md#adr-0005)). The persona, the bans and the few-shot
examples are all passed as written in that language.

Four things change with the language. Get one wrong and the senpai speaks English while
drawing guardrails from Japanese baselines.

| | What switches |
| --- | --- |
| STT / TTS | The `deepgram` model (`DEEPGRAM_TTS_MODEL_JA` / `_EN`) |
| Prompts | `conversationSystemPrompt(vars, locale)` / `boardLessonSystemPrompt(vars, locale)` / `karteSystemPrompt(vars, locale)` |
| Transcript formatting | Role labels (`先輩:` / `Senpai:`) |
| Fixed lines | `senpai.ts` (handover to teach-back, the review opening). Only the opening silence-filler is a bundled mobile asset |
| Guardrails | Answer-leak detection and spoken-maths normalization (`normalizeMathSpeech(text, locale)`) |

The allowed topics need no `locale`: topic_id prefixes are split per locale, so the
allow-list the API passed already determines the curriculum.

## Logs and monitoring

**This is where things break most quietly.** Worker not running, dispatch not
arriving, karte LLM failing - the app shows only "senpai never came / no board / no
karte". Job milestones are emitted as one JSON per line.

| event | When | How to read it |
| --- | --- | --- |
| `job_started` | Job received | Its absence means dispatch never arrived |
| `context_unreadable` | Context unreadable; hang up without talking | Suspect the API's metadata |
| `conversation_started` | Session up (*before* the lesson) | Past here, the senpai can speak |
| `review_hole_missing` | A review built by an old API; degraded to a board-less conversation | If it persists after the API deploy, suspect a version mismatch |
| `lesson_finished` / `lesson_empty` | The result of one lesson | `lesson_empty` is the metric for the 8/16 gate |
| `conversation_ended` | `completed` / `timeout` / `user_left` / `error` | How it ended and how many turns |
| `karte_built` / `karte_failed` | Karte generation | Hole count and duration |
| `complete_posted` / `complete_failed` | Sending to the API | **On failure, no karte ever surfaces** |

`session_id` is on every line, so it joins with `backend/api`'s logs
(`session_created` / `karte_stored`).

With `SENTRY_DSN` set, errors also go to Sentry (unset, nothing is sent).
Conversation content and photo summaries are never sent.

`/complete` is retried up to three times on failure (it is idempotent, so nothing is
duplicated).

## Answer-leak detection is no longer applied

`containsAnswerLeak()` **enforced the pre-revision promise 1, "never give the answer"**,
and is not applied now that the pivot recast the AI as a senpai (the revision in pivot
plan v1 §0, the "drop" column of §8).

Left on, **every time the senpai explains the stuck point it would be logged as a
leak**. Teaching is the job, so nearly every session would warn - which only makes real
anomalies easier to miss.

**The promise that survives is "never fill the answer in first"** (make them say it,
then teach), and that cannot be judged from a single utterance's wording: **the same
sentence is correct after the student explains and a violation before**. It needs turn
order, so a regex guardrail cannot replace it in principle.

What upholds it today is promise 1 in `prompts/senpai_conversation.<locale>.md`, with
**no counterpart in code** (recorded explicitly as "none" in the double-write table in
`prompts/README.md`). To check this mechanically, start by designing around **turn
order** rather than wording.
