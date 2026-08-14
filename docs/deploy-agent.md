# Deploying backend/agent

How to move the AI's conversation pipeline (LiveKit Agents) from a local `pnpm dev` into
a **long-lived container**. `backend/api` (Cloudflare Workers) is in
[`docs/deploy.md`](deploy.md); the language choice is in [ADR 0002](adr.md#adr-0002).

| | develop | production |
| --- | --- | --- |
| Branch | `develop` | `main` |
| LiveKit project | Development | Production |
| Agent name | `ai-sensei-agent-develop` | `ai-sensei-agent-production` |
| `API_BASE_URL` | develop's worker URL | production's worker URL |
| `INTERNAL_API_TOKEN` | The same value as develop's secret | The same value as production's secret |

**Split the LiveKit projects per environment.** Sharing one lets the develop agent pick
up jobs from production rooms (the conversation succeeds, so it is noticed only when
someone spots "a production karte in develop's D1").

---

## 0. What actually runs

`backend/agent` has no build step and runs `.ts` directly with
`node --experimental-strip-types` ([ADR 0002](adr.md#adr-0002)). Deployment amounts to
**keeping one or more Node 22 containers running**.

The worker registers with LiveKit over a WebSocket and waits to be assigned a job.
It is not an HTTP server, so it needs no load balancer and no URL.
Instead, **a health check listens on `0.0.0.0:8081`**.

| Path | Returns |
| --- | --- |
| `GET /` | `200` once registered with LiveKit, `503` until then |
| `GET /worker` | `{"agent_name":"...","active_jobs":0,"sdk_version":"1.6.1",...}` |

**`503` does not mean "the process is down" but "not connected to LiveKit".**
When investigating "nobody arrives", check this is `200` first.

---

## 1. Building the image

The Dockerfile is at the **repository root** ([`Dockerfile`](../Dockerfile)). It sits
there rather than in `backend/agent` for two reasons:

1. The agent references `packages/*` via `workspace:*`, so **the install only resolves
   when the build context is the repository root**.
2. `lk agent create/deploy` **uses the working directory as the build context and reads
   the `Dockerfile` directly inside it.** There is no flag to point elsewhere
   ([§2](#2-hosting-on-livekit-cloud-agent-hosting)).

```bash
docker build -t ai-sensei-agent:local .
# a shortcut that does the same
pnpm --filter @ai-sensei/agent run docker:build
```

Run it locally (with the local `.env`; start `backend/api` separately via
`pnpm --filter @ai-sensei/api dev`):

```bash
pnpm --filter @ai-sensei/agent run docker:run
curl -i http://localhost:8081/          # 200 means it registered with LiveKit
curl -s http://localhost:8081/worker
```

> Running the container with `API_BASE_URL=http://localhost:8787` unchanged makes it look
> at the container's own localhost, so only the karte POST fails. To try the whole flow
> locally, add `--env API_BASE_URL=http://host.docker.internal:8787`.

**Do not quote values in `.env`.** Node's `--env-file`, used by `pnpm dev`, strips the
quotes from `KEY="value"`, but **`docker run --env-file` does not** (the quotes become
part of the value). It shows up in the most time-consuming way possible: the same `.env`
**works under `pnpm dev` and only `docker:run` returns 401**. Trailing whitespace does
the same. When in doubt, look:

```bash
docker run --rm --env-file backend/agent/.env --entrypoint sh ai-sensei-agent:local -c \
  'printf "URL=[%s]\nKEY=[%s]\nSECRET_LEN=%s\n" "$LIVEKIT_URL" "$LIVEKIT_API_KEY" "${#LIVEKIT_API_SECRET}"'
```

Quotes or spaces inside the `[]` mean fixing `.env` (the secret itself is never printed,
only its length).

The `onnxruntime cpuid_info warning: Unknown CPU vendor` at startup **can be ignored**.
It only failed to read the CPU brand; inference still runs on the CPU (common when
emulating an amd64 image on Apple Silicon).

Three things the Dockerfile does that are hard to see from outside:

- **It installs `ca-certificates`.** LiveKit's native core (Rust) reads the system CA
  bundle at runtime. The slim image does not have it, and without it only the TLS
  connection to LiveKit fails. **That breakage appears only in a container**, so it is
  headed off in advance.
- **`ONNXRUNTIME_NODE_INSTALL=skip`.** onnxruntime-node's postinstall fetches **302MB** of
  CUDA/TensorRT execution providers by default, which Silero VAD does not use (it runs on
  the CPU). What CPU execution needs ships with the npm package.
- **`node` is PID 1, with no `pnpm` in between.** On SIGTERM the worker drains (finishing
  conversations in progress before exiting). A process in between blocks the signal and
  **cuts people off mid-sentence**.

---

## 2. Hosting on LiveKit Cloud agent hosting

The first choice. It runs on LiveKit's global network, with scaling and log forwarding
included.

### 2-1. Send the source and let them build

**Run `lk` from the repository root.** The CLI uses the working directory as the build
context and reads the `Dockerfile` directly inside it. That is why the `Dockerfile` is at
the root ([§1](#1-building-the-image)).

> ⚠️ **Handing over a baked image (`--image` / `--image-tar`) does not work.**
> Those flags **push an image from your local Docker daemon to LiveKit's registry**, and
> that push target is Enterprise-only. Using them is refused with
> `Bring Your Own Container is only available for Enterprise projects`.
>
> ```
> failed to get push target: push-target returned 403:
> {"errors":[{"code":"PERMISSION_DENIED","message":"Bring Your Own Container is
> only available for Enterprise projects. ..."}]}
> ```

Splitting `backend/agent` into its own repository is rejected (avoiding a duplicate
implementation of `packages/guardrail` is the very reason TypeScript was chosen, so
breaking that for deployment convenience would defeat the purpose).

### 2-2. The first time

```bash
# install the CLI and connect to the LiveKit account
curl -sSL https://get.livekit.io/cli | bash
lk cloud auth

# from the repository root. Secrets come from a file in .env format
cd <repository root>
lk agent create --secrets-file <secrets file> --skip-sdk-check
```

`--skip-sdk-check` is needed because the CLI checks whether **the working directory's
`package.json` contains `@livekit/agents`**. The root is the workspace container, and the
dependency lives in `backend/agent/package.json`, so without the flag it says the SDK is
missing. It **only downgrades that to a warning** and does not affect the build.

On success, **`livekit.toml` is written out with the agent's id in it**.
The id differs per environment, so **do not commit that file** (it is gitignored).
Deploying from `main` with develop's id still in it would overwrite develop while
believing it was production.

> `lk` is still a fast-moving CLI, so **check the flag names with `lk agent create --help`
> before the first run**. What is written here is the shape as of 2026-08.

### 2-3. Subsequent times

**A release that changes the LiveKit metadata contract must deploy the agent first,
confirm it is live, and only then deploy `backend/api`.** The API and the agent update
separately, so even one commit leaves a window where old and new coexist. For example,
shipping an API that added `review_hole` first means an old agent's
`sessionMetadataSchema` - which is `.strict()` - rejects the unknown key and disconnects
with `context_unreadable`. New lessons carry `review_hole: null` too, so in that window
**no senpai arrives in any session**, not just reviews.

Deploying the agent first, the new agent can also read metadata where an old API omitted
`review_hole`. Only reviews in that window log `review_hole_missing` and degrade to the
old board-less conversation, returning to board lessons naturally once the API deploys.
Confirm the new replicas are live with `lk agent status`, then start the API's deploy.
The two GitHub Actions have no dependency and are not ordered even when triggered by the
same push. For a contract change, deploy that commit's agent first with the CLI in this
section, or split the release in two - never start the API's deploy before confirming
the agent is live.

```bash
cd <repository root>
lk agent deploy --id <agent-id>
```

The build runs on their side. **Confirming `docker build` works locally first**
reduces how often you have to read their build log ([§1](#1-building-the-image)).

```bash
lk agent status --id <agent-id>    # replica count, CPU, state
lk agent logs   --id <agent-id>    # the one-JSON-per-line logs, verbatim
```

### 2-4. production

Swap `--id` and `--secrets-file` for production's and do the same thing twice.
**Not reusing `livekit.toml`** is the single best accident prevention.

---

## 3. Secrets

[`backend/agent/.env.example`](../backend/agent/.env.example) is authoritative for the
environment variables the agent reads. Put **the same keys, unchanged**, into the
deployment target.

| Name | Required | Content |
| --- | --- | --- |
| `API_BASE_URL` | Yes | The `backend/api` worker URL for that environment |
| `INTERNAL_API_TOKEN` | Yes | The same value as `backend/api`'s secret **in the same environment** |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Yes | From that environment's LiveKit project |
| `ANTHROPIC_API_KEY` | Yes | The conversation and karte LLMs |
| `DEEPGRAM_API_KEY` | Yes | Shared by STT and TTS |
| `LLM_MODEL_CONVERSATION` / `LLM_MODEL_KARTE` | Optional | Unset means `config.ts`'s defaults |
| `DEEPGRAM_TTS_MODEL_JA` / `_EN` | Optional | **Normally left alone** (the voice is the character) |
| `SENTRY_DSN` | Optional | Unset sends nothing to Sentry |
| `ENVIRONMENT` | Optional | The name shown in Sentry. `develop` / `production` |
| `LIVEKIT_AGENT_NAME` | Depends | [§4](#4-dispatch) |

**A missing value fails at startup** (`loadConfig` validates once at boot).
Noticing mid-conversation is the most expensive outcome, hence the design.

- **`INTERNAL_API_TOKEN` must differ per environment.** Otherwise the develop agent can
  call production's `/complete` ([ADR 0003](adr.md#adr-0003)).
- **LiveKit Cloud hosting injects `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
  `LIVEKIT_API_SECRET` itself.** Supplying your own can conflict, so when hosting there
  you may drop those three from `--secrets-file`.

After swapping a secret, **redeploy even with no code change** (an already-running
worker's process does not pick up the new value).

---

## 4. Dispatch

How the worker registers changes how it is called. When this does not mesh with
`backend/api`'s configuration, **the room is created and nobody arrives** (the app sits on
"listening").

| Agent side | How it is called | `backend/api`'s `LIVEKIT_AGENT_NAME` |
| --- | --- | --- |
| No `LIVEKIT_AGENT_NAME` | Auto dispatch; it joins every room in the project | Leave it empty |
| `LIVEKIT_AGENT_NAME` set | Explicit dispatch only | **Put the same name in** |

**LiveKit Cloud's agent hosting sets `LIVEKIT_AGENT_NAME` automatically.**
So the moment you move there it becomes "named", and without the same name on the
`backend/api` side, nobody arrives.

```bash
lk agent status --id <agent-id>                     # check the name it reports
curl -s http://localhost:8081/worker                # locally, read agent_name
cd backend/api && pnpm exec wrangler secret put LIVEKIT_AGENT_NAME --env develop
```

---

## 5. Automatic deploys from GitHub Actions

The template is [`docs/ci/deploy-agent.yml`](ci/deploy-agent.yml).
A GitHub App cannot push into `.github/workflows/`, so **the repository owner copies it by
hand, once** (the same situation as `backend/api`; see
[`docs/ci/README.md`](ci/README.md)).

```bash
cp docs/ci/deploy-agent.yml .github/workflows/deploy-agent.yml
git add .github/workflows/deploy-agent.yml
git commit -m "ci: enable agent deploy workflow"
```

The required Secrets and Variables (Settings > Secrets and variables > Actions).
To split develop and production, put them under **Environments** rather than
repository-wide.

| Kind | Name | Content |
| --- | --- | --- |
| Secret | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Used to authenticate `lk`. From that environment's LiveKit project |
| Secret | `LIVEKIT_URL` | As above |
| Variable | `LIVEKIT_AGENT_ID` | The id returned by `lk agent create` (`CA_...`) |

**No image registry is needed.** The workflow only sends the source; the build runs on
LiveKit's side.

---

## 6. Without LiveKit Cloud

Anywhere a container can stay resident works (Fly.io / Render / ECS / an always-on Cloud
Run / your own Node 22). This is ADR 0002's "if unavailable" path, and **the image is
exactly the same**.

Only four things matter:

| Item | Value | Why |
| --- | --- | --- |
| Health check | `GET :8081/` returns 200 | It only returns 200 once registered with LiveKit |
| Shutdown grace | **60 seconds or more** | Draining after SIGTERM. Too short cuts conversations off |
| Scaling direction | Add replicas (do not grow one) | A worker refuses new jobs at 70% load |
| Memory | About 2GB per replica | Production mode keeps `min(CPU count, 4)` child processes resident, each holding a VAD model |

**Never configure it to scale in to zero** (a Cloud Run-style scale-to-zero setup means
nobody is listening when a job arrives).

---

## 7. What to look at when it stops working

The agent **breaks quietly**. The app only ever shows "nobody arrives" or "no karte".
Logs are one JSON per line and every line carries `session_id`, so they can be lined up
with `backend/api`'s.

| Symptom | What to look at |
| --- | --- |
| Nobody arrives | First, is `GET :8081/` 200? If so, is `job_started` present? If not, see [§4, dispatch](#4-dispatch) |
| Crashes right after startup | It prints "cannot read the agent's environment variable: `<name>` (`<reason>`)". The name and reason are the cause. [§3](#3-secrets) |
| Only `closing worker due to error.` | The framework swallowed a startup exception. **Environment variables are checked before that point, so if you got here, suspect something else** (a port clash, say) |
| Cannot connect to LiveKit (`401`) | The key is being rejected. **Check `LIVEKIT_URL`'s project and where `LIVEKIT_API_KEY`/`SECRET` came from line up** (a classic mix-up right after splitting environments). Then check `.env` for quotes and trailing whitespace ([§1](#1-building-the-image)) |
| Cannot connect to LiveKit (TLS failure) | Whether `ca-certificates` is present (after swapping in your own image) |
| The conversation starts and immediately drops | `context_unreadable`. Suspect the token metadata the API attached |
| No karte | `karte_failed` / `complete_failed`, and the API's `complete_unauthorized`. A cross-environment `INTERNAL_API_TOKEN` is the classic cause |
| Conversations drop only right after a deploy | The shutdown grace is too short to drain ([§6](#6-without-livekit-cloud)) |

The event list is in [`backend/agent/README.md`](../backend/agent/README.md).
With `SENTRY_DSN` set, `*_failed` also reaches Sentry (conversation content and photo
summaries are never sent).

---

## Not done yet

- **The actual deployment.** What is written here is the procedure; it has never been
  run. The first thing to confirm is what [ADR 0002](adr.md#adr-0002) flagged:
  **that `prewarm` (loading Silero VAD) works in a container.** `GET :8081/` returning
  200 means it does.
- **Autoscale tuning.** One replica is assumed for now. Concurrent session counts are
  only readable after W2's Go/No-Go, so until then the replica count is set by hand.
- **Rollback.** The build happens on LiveKit's side, so no image remains here. For now
  the only way is **checking out the commit to revert to and deploying again**
  (whether `lk agent rollback` exists is unverified; check `lk agent --help`).
