# CI workflow templates

The YAML here is a set of templates meant to be dropped into `.github/workflows/`
as-is.

```bash
mkdir -p .github/workflows
cp docs/ci/ci.yml           .github/workflows/ci.yml
cp docs/ci/deploy.yml       .github/workflows/deploy.yml
cp docs/ci/deploy-agent.yml .github/workflows/deploy-agent.yml
cp docs/ci/golden.yml       .github/workflows/golden.yml
git add .github/workflows/ && git commit -m "ci: enable CI and deploy workflows"
```

When the destination already exists, **the template is authoritative** and may be
overwritten (to inspect the difference first, `diff docs/ci/ci.yml
.github/workflows/ci.yml`).

> **If you edit `.github/workflows/` directly, write it back into the template.**
> Only the repository owner can edit `.github/workflows/` directly, so it can move
> ahead while the template is left behind. That really happened: `ci.yml`'s
> per-directory job filtering (commit `c6d9f94`) was missing from the template, so
> **running the `cp` above would have deleted it** (synced on 2026-08-10).
> When `diff` is non-empty, **work out which side is newer before** running `cp`.

> **Why a template directory?**
> A GitHub App (Claude Code and other automation) has no `workflows` permission and
> cannot push files under `.github/workflows/` (`refusing to allow a GitHub App to
> create or update workflow`). Once the repository owner commits the copy above by
> hand, later updates follow the same procedure.

## The workflows

| File | Trigger | Content |
| -------- | ------ | ---- |
| `ci.yml` | push to `develop`/`main`, every PR | `pnpm run lint` (Biome) / `pnpm run typecheck` / `pnpm test` / a dry-run Worker build / Flutter (analyze + test) / secret scanning |
| `deploy.yml` | push to `develop`/`main` (when `backend/api` and friends changed), manual | Deploys `backend/api` to Cloudflare Workers. `develop` -> develop environment, `main` -> production |
| `deploy-agent.yml` | push to `develop`/`main` (when `backend/agent` and friends changed), manual | Deploys `backend/agent` to LiveKit Cloud (the source is sent and the build runs there) |
| `golden.yml` | **manual only** | Re-bakes the golden test PNGs on Linux and publishes them as an artifact (see below) |

`deploy.yml` needs a Cloudflare API token. Creating resources, registering secrets
and the token's permissions are covered in [`docs/deploy.md`](../deploy.md).
**No deploy runs until the resource ids are filled in** (a remaining `REPLACE_ME` in
`wrangler.toml` fails the workflow's first step).

`deploy-agent.yml` needs a LiveKit API key and the agent id returned by
`lk agent create` (the `LIVEKIT_AGENT_ID` variable). **Only the first registration is
done by hand** (see [`docs/deploy-agent.md`](../deploy-agent.md)).

The Flutter version is read from `apps/mobile/.fvmrc` (so local fvm and CI use the
same value). Golden tests treat **Linux rasterization as authoritative**, so they are
generated in CI too.

lint, typecheck and test are chained with `if: !cancelled()`, so what follows runs
even when lint fails (so one CI run shows everything that needs fixing).

Building and distributing `apps/mobile` happens on Codemagic (`codemagic.yaml` at the
repository root), so GitHub Actions does not handle it.
The Codemagic-side setup (switching to YAML, API keys, keystore, variable groups) is
in [`codemagic.md`](./codemagic.md), and the receiving side (App Store Connect / Play
Console) is in [`store-setup.md`](./store-setup.md).

The authoritative golden run is here (ubuntu-latest). Codemagic runs macOS, so
goldens are tagged `golden` and excluded with `--exclude-tags golden`.

## Re-baking goldens (`golden.yml`)

`ci.yml` only **compares** goldens; it never re-bakes them.
Re-baking is started **manually from Actions** via `golden.yml`
(Actions → Update goldens → Run workflow → choose a branch).
The output lands in the `goldens` artifact: download it, put it in
`apps/mobile/test/golden/goldens/` and commit it **in the same commit as the test
file**. The whole workflow is described in
[`apps/mobile/test/golden/README.md`](../../apps/mobile/test/golden/README.md).

**Not running it automatically is deliberate.** Re-baking on every push makes goldens
a permanent rubber stamp and **destroys their ability to detect breakage**.

The Flutter version is read **from the same `.fvmrc` as `ci.yml`**.
It reads the same file rather than repeating the same value, because if bumping
`.fvmrc` left one side stale, the baked PNGs would **differ from the moment they were
created**. The runner is `ubuntu-latest` on both sides too.
