# @ai-sensei/api

Cloudflare Workers + Hono. Handles session creation, karte storage and the billing
webhook.

## Endpoints

| Method | Path | Auth | Role |
| --- | --- | --- | --- |
| POST | `/v1/sessions` | `X-Device-Id` | Photo analysis -> unit detection (**nothing is counted yet**) |
| PATCH | `/v1/sessions/{id}/topics` | `X-Device-Id` | Applies units removed in the chip UI (no re-analysis) |
| POST | `/v1/sessions/{id}/start` | `X-Device-Id` | **Starts the conversation, counting today's use**, and returns the LiveKit room and token |
| POST | `/v1/sessions/{id}/complete` | `Bearer INTERNAL_API_TOKEN` | Called by the agent. Stores the karte and books review pushes |
| GET | `/v1/sessions/{id}/result` | `X-Device-Id` | The app fetches the result after a conversation (202 while generating) |
| GET | `/v1/me/progress` | `X-Device-Id` | Streak days and filled holes |
| GET | `/v1/me/reviews` | `X-Device-Id` | The free quiz plus whether the voice lesson needs Premium |
| POST | `/v1/me/reviews/{holeId}` | `X-Device-Id` | The quiz self-report (said it / not yet) |
| POST | `/v1/webhooks/revenuecat` | shared secret | Entitlement sync |
| GET | `/health` | none | Liveness. Reports which environment (`{"ok":true,"environment":"production"}`) |

Auth is an **anonymous device id**. No account is required: the client sends a UUID it
generated in `X-Device-Id`.

Only `/complete` is an internal endpoint called by the agent, protected by one shared
secret (`INTERNAL_API_TOKEN`). **It is static, has no expiry and no scope, so it will
move to a short-lived session-scoped token.** The decision to leave it for now, and
the routes that look obvious but do not work (the LiveKit token's `metadata` is
readable from the app), are in [ADR 0003](../../docs/adr.md#adr-0003).

## Local development

```bash
cp .dev.vars.example .dev.vars
pnpm --filter @ai-sensei/api migrate:local   # apply the schema to D1
pnpm --filter @ai-sensei/api dev             # http://localhost:8787
```

Locally, miniflare provides fakes for D1/R2/KV, so **no ids need substituting**
(`wrangler.toml`'s top level is the `wrangler dev`-only configuration).

## Deployment

There are **two environments, develop and production**. Steps are in
[`docs/deploy.md`](../../docs/deploy.md).

```bash
pnpm run deploy:develop      # the develop branch
pnpm run deploy:production   # the main branch

pnpm run migrate:develop     # D1 migrations (--remote)
pnpm run migrate:production

pnpm run secret:develop LIVEKIT_API_KEY   # secrets are registered per environment
pnpm run tail:develop                     # watch the logs
```

A push to `develop`/`main` makes GitHub Actions do the same
([`docs/ci/deploy.yml`](../../docs/ci/deploy.yml)).

**Never use `wrangler deploy` without `--env`.** It would create a third worker under
the top-level name (`ai-sensei-api`), so `pnpm run deploy` treats a missing flag as a
mistake and fails.

`GET /health` returns the environment name, as in
`{"ok":true,"environment":"develop"}`. The two workers look identical, so this is how
a mixed-up URL is noticed.

## How the conversation partner (agent) is called

`POST /v1/sessions/{id}/start` creates the room and issues the token; **LiveKit calls
the agent**. There are two ways, decided by how the worker is registered.

| Worker | How it is called | API setting |
| --- | --- | --- |
| Unnamed | Auto dispatch (every room) | do not set `LIVEKIT_AGENT_NAME` |
| Named | Explicit dispatch | put the same name in `LIVEKIT_AGENT_NAME` |

**LiveKit Cloud agent hosting sets `LIVEKIT_AGENT_NAME` automatically**, so deploying
there makes it named. Named workers are excluded from auto dispatch, so unless the API
calls them via `roomConfig`, **the room opens and nobody arrives** (the app sits on
"listening", and neither conversation nor karte happens).

Which mode is in effect is visible in the `session_created` log's `agent_dispatch`
(`explicit` / `automatic`).

## Logs and monitoring

Workers Observability (`[observability]` in `wrangler.toml`) is enabled.
**Every log is one JSON per line**, filterable by field in the dashboard and in
`wrangler tail`.

```bash
pnpm run tail:develop
```

| event | When | Main fields |
| --- | --- | --- |
| `http_request` | One line per request | `route` `status` `duration_ms` `error_code` |
| `session_created` | A session was created | `session_id` `topic_ids` `agent_dispatch` |
| `session_rejected` | Unreadable photo etc. (expected) | `session_id` `status` |
| `photo_analysis_failed` | The Vision API failed (unexpected) | `session_id` `error_message` |
| `karte_stored` | A karte was stored | `session_id` `ended_reason` `holes` `transcript_turns` |
| `complete_unauthorized` | The agent's internal token has drifted | `session_id` |
| `unhandled_error` | Unexpected; the app sees internal_error | `route` `error_stack` |

Every response returns `x-trace-id`. It is the only way to match a user report against
the logs, so ask for it first in support.

With `SENTRY_DSN` registered, `unhandled_error` and each `*_failed` also go to Sentry
(unset, nothing is sent and only structured logs remain). Photos, kartes and device ids
are never sent. When the per-request line is noise, `LOG_LEVEL=error` narrows it to
failures.

## Tests

`pnpm test` (vitest). Persistence, photo analysis and notifications are all swappable
so **route behaviour can be checked without starting miniflare**.

```ts
const app = createApp({ services: () => testServices() });
await app.request("/v1/sessions", { method: "POST", body: form }, testBindings());
```

- `repository/memory.ts` — in place of D1
- `test-support.ts` — the photo-analysis stub, a recording notification scheduler, bindings

## Design points

**Lesson slots are counted on the server.** Free is one session a day; Premium's
hidden fair-use cap is three, which ordinary use (1-2 a day) never reaches. Quality
does not vary by plan: both get up to 20 minutes, enough for a 15-20 minute lesson. The
decision lives in `lib/entitlement.ts` and never trusts the client's claim. On hitting
the cap it returns the seconds until midnight (JST) so the app can say "tell me the
rest tomorrow" without showing the number.

**During the closed beta, everyone is Premium-equivalent, with an expiry.**
While `BETA_OPEN_ACCESS_UNTIL` is set, `hasPremiumAccess` returns true without checking
payment (only the count comes from `BETA_SESSIONS_PER_DAY`, default 10). Only people on
the limited-release tester list can install the app during that period, so there is no
need to register device ids one by one.
**Every feature-unlock check goes through `hasPremiumAccess`, while `isPremiumNow`
keeps answering "did they actually pay"** - conflated, webhook sync and TRANSFER expiry
inheritance would grab false values. How to switch it, and the risk of forgetting to
remove it, are in [docs/deploy.md](../../docs/deploy.md).

**What is counted is conversations with the senpai, not photos read.** The slot used to
be claimed at analysis time (`POST /v1/sessions`), so a student who only photographed
and confirmed the unit was told "that's it for today" without a single conversation.
Now `POST /{id}/start` claims the slot in the one statement that writes
`sessions.started_at`, **and issues the token in the same operation**.
The order cannot be swapped - no slot means no key, and a key means the slot was taken.
Handing out the key at analysis time would mean "holding the key = able to start any
time", which puts the counter on the client.

A retry does not count twice (`started_at IS NULL` is in the condition, so the second
attempt reissues only the token). The counted day (`local_date`) is rewritten at start
too, so a conversation begun across midnight counts on the day it started.

**A token can be reissued only while the first key is alive** (`canReissueToken`: the
time cap plus a margin). Reissuing unconditionally would make a session opened without
entering the room a voucher for a key with no expiry - without a conversation
`/complete` never arrives, the row stays open, and pressing that id tomorrow adds a
lesson without spending today's slot. Sessions past the window return 404, so the app
does not keep holding the same id either.

**Analysis has a separate, far looser cap.** Vision LLM cost is incurred even without a
conversation, so the session rows creatable in a day are capped by `analysesPerDay`
(the lesson slot x 5). It sits where ordinary retakes never reach it, and its wording
matches the daily cap. On top of that, anyone who has used up today's lessons is
refused **before the photo is read** (the pre-check in `/v1/sessions`).

**The second guardrail runs here too.** The holes in the karte received at `/complete`
are matched against that session's allowed topics, and off-list tags are dropped
(`filterHoleTopicIds`), because an off-target tag makes the review notification
off-target too.

**The quiz is free; calling the senpai back by voice is Premium.** `/v1/me/reviews`
returns the queue for every user, but `/v1/sessions` with `kind=review` requires
Premium server-side as well. Relying on the response flag alone would let the
`hole_id` handed out in the first karte be used to call directly. The hole's owner
(device_id) is checked both at session creation and at completion.

**`/complete` is idempotent.** When the agent resends after a timeout, passing it
through would duplicate the karte, the holes and the notification bookings. For a
session that already has a karte, the stored one is returned.

**The cap check and the write are one statement.** Separated, two concurrent requests
both see "zero uses today" and both pass. The lesson slot puts the cap's COUNT into the
`WHERE` of the UPDATE that writes `started_at`, and the analysis slot is claimed with a
conditional INSERT (SQLite executes one statement atomically, so concurrent requests
cannot both pass on the same stale COUNT). A failed analysis deletes the row, so an
unreadable photo never costs an analysis slot.

**A failed notification never stops the experience.** The karte is returned even if the
OneSignal booking failed. When a hole is filled, the remaining bookings are cancelled
(a notification about a hole you already filled is the most deflating thing there is).

**A scheduled cancellation does not revoke Premium.** RevenueCat's `CANCELLATION` is a
scheduled cancellation and stays Premium until expiry. "What was paid for stays usable
to the end" is the floor of honesty (HAMM).

**No score column in D1.** The `kartes` table has no score column; only streak days and
filled holes are counted.

**`locale` switches the curriculum, not just the language.** `POST /v1/sessions`'s
`locale` selects the curriculum map handed to the Vision LLM (Japanese Math I-C /
overseas Algebra 1+) and the prompt itself. A `topic_id` returned from another
curriculum is rejected. The course names shown on chips come back in that curriculum's
language too ([ADR 0005](../../docs/adr.md#adr-0005)).

**A hole's language comes from its `topic_id`.** Instead of storing `locale` in the DB,
the prefix `M2-...` (Japan) or `A2-...` (overseas) decides that hole's language. The
review notification (booked at `/complete`) and the review queue's one-liner
(`/v1/me/reviews`) follow it, so changing the device language never delivers a hole
explained in Japanese in English.

## The LiveKit token

`server-sdk-js` depends on Node APIs, so on Workers the JWT (HS256) is built by hand
with WebCrypto (`lib/livekit.ts`).
The token's `metadata` carries the photo interpretation, the allowed topics, the
question seeds and the remaining seconds to the agent. **The in-conversation guardrails
use that metadata as their baseline.**
