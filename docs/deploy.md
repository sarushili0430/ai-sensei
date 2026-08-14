# Deploying backend/api

How to stand up **two deployments, develop and production**, on Cloudflare Workers.
The configuration itself is [`backend/api/wrangler.toml`](../backend/api/wrangler.toml),
and automatic deployment is [`docs/ci/deploy.yml`](ci/deploy.yml)
(a GitHub App cannot push into `.github/workflows/`, so that directory is a template
store; [§4-0](#4-0-place-the-workflow) copies it by hand once).

| | develop | production |
| --- | --- | --- |
| Branch | `develop` | `main` |
| Worker name | `ai-sensei-api-develop` | `ai-sensei-api-production` |
| D1 | `ai-sensei-develop` | `ai-sensei-production` |
| R2 | `ai-sensei-photos-develop` | `ai-sensei-photos-production` |
| KV | A separate namespace | A separate namespace |
| Secrets | Registered with `--env develop` | Registered with `--env production` |

**The binding names (`DB` / `PHOTOS` / `METER`) are identical in both environments.**
The code is unaware of the environment; only the resources differ. D1, R2 and KV are
never shared, so test data or a karte you forgot to delete on develop cannot leak into
production.

Deploying `backend/agent` (LiveKit Agents) is covered in
[`docs/deploy-agent.md`](deploy-agent.md). It is not handled here, but **what the agent
connects to changes per environment**, which is in [§6](#6-the-surrounding-settings).

---

## 0. Prerequisites

```bash
pnpm install
pnpm --filter @ai-sensei/api exec wrangler login   # log in to Cloudflare in a browser
```

Everything fits Cloudflare's free plan, but **D1, R2 and KV sometimes need enabling once
per account**. If a `create` below fails with a permission error, open each product once
in the dashboard to enable it.

> This repository contains no real Cloudflare account values.
> The steps below **have not been run**; create the resources yourself and substitute the
> ids.

---

## 1. Create the resources (once per environment)

Do the same thing twice, for `develop` and `production`. The example below is develop.

### D1

```bash
cd backend/api
pnpm exec wrangler d1 create ai-sensei-develop
```

Paste the output's `database_id` over the `REPLACE_ME` in `wrangler.toml`'s
`[[env.develop.d1_databases]]`.

### KV (free-tier metering)

```bash
pnpm exec wrangler kv namespace create METER --env develop
```

Paste the output's `id` over the `REPLACE_ME` in `[[env.develop.kv_namespaces]]`.

### R2 (notes photos)

```bash
pnpm exec wrangler r2 bucket create ai-sensei-photos-develop
```

R2 is looked up by bucket name, so no id substitution is needed.

### The production side

Read `develop` as `production`, create the same three, and fill in the `REPLACE_ME`s
under `[[env.production.*]]`.

Whether they are filled in can be checked locally, per environment.

```bash
pnpm run verify:bindings develop
# ✔ [env.develop]'s bindings are configured
```

**No deploy is possible to an environment with a remaining `REPLACE_ME`** (GitHub
Actions' `Check bindings are filled in` fails on the same check). It only inspects
**the target environment's sections**, so **bringing up develop first and creating
production later is perfectly fine.**

---

## 2. Registering secrets

`wrangler.toml`'s `[vars]` holds **only configuration that may be public**.
Keys go in per environment with `wrangler secret put`.

```bash
cd backend/api
for name in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET \
            ANTHROPIC_API_KEY ONESIGNAL_APP_ID ONESIGNAL_REST_API_KEY \
            REVENUECAT_WEBHOOK_AUTH INTERNAL_API_TOKEN; do
  pnpm exec wrangler secret put "$name" --env develop
done
```

Two optional ones.

```bash
pnpm exec wrangler secret put SENTRY_DSN --env develop          # errors to Sentry
pnpm exec wrangler secret put LIVEKIT_AGENT_NAME --env develop  # when the agent is named
```

**Set `LIVEKIT_AGENT_NAME` only when the agent worker runs with a name** (LiveKit Cloud's
agent hosting names it automatically). Named workers are excluded from auto dispatch, so
if this is empty the room is created and nobody arrives - the app sits on "listening".
Details in
[backend/api/README.md](../backend/api/README.md).

`pnpm run secret:develop <NAME>` / `secret:production <NAME>` do the same
(a shortcut that prevents forgetting `--env`).
What each value is is documented in
[`backend/api/.dev.vars.example`](../backend/api/.dev.vars.example).

**The value cannot be passed as an argument.** `wrangler secret put` takes only `<key>`
positionally, and the value comes from a prompt (stdin). That design keeps it out of
shell history, so paste it when asked. To load five at once, use
`wrangler secret bulk <file>.json --env develop` (plain text, so keep it outside the
repository and delete it afterwards).

The first time you will be asked **"There doesn't seem to be a Worker called
'ai-sensei-api-develop'. Do you want to create a new Worker with that name...?"**.
**Answer yes.** The worker's shell is created first as a place for secrets, and
`deploy:develop` later puts the code into it. Secrets survive deploys, so they need not
be re-entered.

A few notes:

- **Leaving `REVENUECAT_WEBHOOK_AUTH` empty rejects every webhook.** It is designed not
  to authorize on an empty string, so unset = closed is correct.
- **`INTERNAL_API_TOKEN` must match the agent's value**, and **must differ per
  environment** (otherwise the develop agent can call production's `/complete`). The
  value is static and unscoped: holding it lets you write a karte to any session. The
  plan to move to a short-lived session-scoped token, and why, are in
  [ADR 0003](adr.md#adr-0003).
- `ONESIGNAL_*` may be unset (notification bookings are skipped). Leaving them out on
  develop is a valid way to operate.

List what is registered with `pnpm exec wrangler secret list --env develop`.

---

## 3. Migrations and the first deploy

**For a release that changes the LiveKit metadata contract, deploy the agent before the
API.** The procedure and reasoning are in
[`docs/deploy-agent.md` §2-3](deploy-agent.md). Shipping the API first means a
`.strict()` old agent rejects metadata containing new keys and could disconnect every
session with `context_unreadable`. The recent `review_hole` also rides new lessons as
`null`, so the impact is not limited to reviews. Confirm the new agent is running first,
and the window where an old API omits the key degrades only reviews to a board-less
conversation with a warning, without dropping connections.
The agent's and the API's GitHub Actions are independent, and even one push guarantees no
ordering. For a contract change, deploy that commit's agent ahead of time via the CLI or
split the release in two, and start the API only after confirming the agent is live.

```bash
cd backend/api
pnpm run migrate:develop     # apply the schema to D1
pnpm run deploy:develop
```

Note the `https://ai-sensei-api-develop.<subdomain>.workers.dev` that `wrangler deploy`
prints.

```bash
curl https://ai-sensei-api-develop.<subdomain>.workers.dev/health
# {"ok":true,"environment":"develop"}
```

`environment` is returned so **a mixed-up develop and production** can be caught with one
curl. Production follows the same steps.

> `wrangler deploy` without `--env` creates **a third worker** under the top-level name
> (`ai-sensei-api`). `pnpm run deploy` treats a missing flag as a mistake and fails, so
> use `deploy:develop` / `deploy:production`.

---

## 4. Automatic deploys from GitHub Actions

Once the above works, a push to `develop` / `main` deploys automatically.

### 4-0. Place the workflow

A GitHub App (Claude Code and the like) cannot push under `.github/workflows/`, so the
YAML lives in [`docs/ci/`](ci/README.md) as a template.
**The repository owner copies it by hand, once.**

```bash
cp docs/ci/deploy.yml .github/workflows/deploy.yml
git add .github/workflows/deploy.yml
git commit -m "ci: enable backend deploy workflow"
```

### 4-1. Create an API token

Cloudflare dashboard > My Profile > **API Tokens** > Create Token.
Base it on the **"Edit Cloudflare Workers"** template, and make sure it has:

| Kind | Permission | Purpose |
| --- | --- | --- |
| Account | Workers Scripts : Edit | `wrangler deploy` |
| Account | D1 : Edit | Applying migrations |
| Account | Workers KV Storage : Edit | The KV binding |
| Account | Workers R2 Storage : Edit | The R2 binding |
| Account | Account Settings : Read | Resolving the workers.dev subdomain |

### 4-2. Register it in the repository

Settings > Secrets and variables > Actions > **Secrets**:

| Name | Content |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from 4-1 |
| `CLOUDFLARE_ACCOUNT_ID` | The Account ID on the right of the dashboard |

To use different Cloudflare accounts for develop and production, register them under
Settings > **Environments** > `develop` / `production` rather than repository-wide (the
workflow specifies `environment:`, so the environment's values win).

### 4-3. Require approval for production (optional)

Adding yourself to Settings > Environments > `production` > **Required reviewers** pauses
the deploy on a push to `main` until you approve it on GitHub.

### What the workflow does

1. Checks the target environment's bindings are filled in (`verify:bindings`)
2. `pnpm run verify` (lint / typecheck / secret scan / tests)
3. `wrangler d1 migrations apply --remote`
4. `wrangler deploy --env <target>`
5. Hits `/health` and checks the reported environment name matches

The checks overlap with CI (`ci.yml`), but the deploy job is self-contained, because the
commit that was green in CI and the commit actually being deployed can differ.

To re-run with no code change (after swapping a secret, say), use
Actions > Deploy (backend/api) > **Run workflow** and pick the environment.

---

## 5. Operations

```bash
cd backend/api
pnpm run tail:develop        # watch the logs (wrangler tail)
pnpm run tail:production
```

**Rolling back** is fastest from the Cloudflare dashboard > Workers > the worker >
Deployments, reverting to a previous version
(`wrangler rollback --env production` also works).
**D1 migrations do not roll back.** Changes that drop a column or change a type must be
split into "add -> run with both -> drop later".

### Opening everything for free during the closed beta

Two `vars` in `wrangler.toml` switch it. **No app change and no release are needed.**

| Variable | Meaning |
| --- | --- |
| `BETA_OPEN_ACCESS_UNTIL` | The open-access deadline (ISO8601). **Everyone is Premium-equivalent until then.** Absent or unreadable means business as usual |
| `BETA_SESSIONS_PER_DAY` | The daily lesson count while open (default 10). Conversation length is the usual 20-minute maximum |

```bash
cd backend/api
# to extend or shorten it, edit wrangler.toml and deploy
pnpm run deploy:production
```

Why that suffices: **during this period the only people who can install the app are those
on Play's closed-testing list or in TestFlight**, so "everyone" and "testers" are the same
set. There is no need to collect device ids and grant them one by one, nor to re-grant
after a new device.

While open, every place the check runs answers the same
(`hasPremiumAccess` in `lib/entitlement.ts`). Voice review lessons, study plans, the
parent report and follow-up questions all unlock, and **the post-karte paywall never
appears** - testers never touch a purchase screen, so "free" really is free as a route.
Hitting the daily cap also returns `fair_use_limit_reached` (wording that does not
suggest paying).

Notes:

- **Always remove it before public launch.** Left in, the only way it is noticed is that
  billing works and nobody sees the purchase screen. The deadline exists so it ends by
  itself if forgotten.
- **`isPremiumNow` does not change.** Beta access decides whether to unlock features, not
  whether payment happened. RevenueCat's webhook sync and TRANSFER inheritance still look
  only at people who really paid.
- **The cap is not removed.** However unlimited it feels, LiveKit, STT, LLM and TTS costs
  run the same for testers, so `BETA_SESSIONS_PER_DAY` stops abuse.
- Testers never reach the purchase screen on their own, but **adding their accounts to
  Play Console's "License testing"** makes any accidental purchase a test purchase (no
  charge).

---

## 6. The surrounding settings

Splitting the API into two environments means the things it connects to come in twos too.

| | develop | production |
| --- | --- | --- |
| LiveKit | A development project | A production project |
| The agent's `API_BASE_URL` | develop's worker URL | production's worker URL |
| The agent's `INTERNAL_API_TOKEN` | The same value as develop's secret | The same value as production's secret |
| RevenueCat webhook | develop's `/v1/webhooks/revenuecat` | production's `/v1/webhooks/revenuecat` |
| Codemagic's `API_BASE_URL` | — | production's worker URL |

- **Split the LiveKit projects.** Sharing one would let the develop agent pick up jobs
  from production rooms. Use different `LIVEKIT_URL` / `API_KEY` / `API_SECRET` per
  environment, with the agent and the API looking at the same set.
- **Point the RevenueCat webhook at a different destination per environment**, so sandbox
  events are not written into production's D1. `REVENUECAT_WEBHOOK_AUTH` differs too.
- **Point Codemagic's builds at production.** A TestFlight build hitting develop's API
  would put testers' activity into the development D1
  (`API_BASE_URL` in the `mobile-dart-defines` variable group;
  [codemagic.md](ci/codemagic.md)).
  Local `flutter run` uses `--dart-define=API_BASE_URL=http://localhost:8787`.

---

## 7. What to look at when it stops working

The backend **breaks quietly** (the app only ever shows "listening" forever, or "no
karte"). Logs are one JSON per line, so filter by field.

```bash
pnpm --filter @ai-sensei/api tail:develop     # watch Workers Logs
```

| Symptom | What to look at |
| --- | --- |
| Nothing happens after taking a photo | Is `session_created` present? If not, `photo_analysis_failed` / `session_rejected` |
| The conversation never starts (nobody arrives) | The agent's `job_started`. Without it, suspect dispatch (`agent_dispatch` in `session_created`) |
| The conversation worked but there is no karte | The agent's `karte_failed` / `complete_failed`, the API's `complete_unauthorized` / `karte_stored` |
| A user report | The response's `x-trace-id`. Look up the logs by that value |

With `SENTRY_DSN` set, `unhandled_error` and each `*_failed` also reach Sentry.
The API and the agent share `session_id` as a key, so both sets of logs can be lined up.

---

## Not done yet

- **A custom domain.** Both environments are on `*.workers.dev`. After pointing a custom
  domain at production, set `workers_dev = false` in `wrangler.toml`'s
  `[env.production]` and add `[[env.production.routes]]` (leaving the workers.dev URL
  keeps it alive as a stray endpoint).
- **Tracing.** Sentry is in place but for errors only (`tracesSampleRate: 0`). Where time
  is spent is currently read from `http_request`'s `duration_ms`.
