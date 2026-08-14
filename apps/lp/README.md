# apps/lp — landing page

The introduction page for Katarute (ai-sensei). **Japanese (`index.html`) and English
(`en/index.html`) are one pair.**

```
apps/lp/
  wrangler.jsonc         Cloudflare Workers (static assets) config
  package.json           deploy / dev scripts
  public/                the only directory that is published
    index.html           Japanese
    en/index.html        English
    beta/index.html      how to join the closed beta (Japanese)
    en/beta/index.html   the same (English)
    styles.css           the single stylesheet shared by every page
```

**Anything that goes on the site must live inside `public/`.** `wrangler.jsonc`'s
`assets.directory` points at `./public`, so files outside it are not served (and
conversely, everything in `public/` is published as-is).

There are four intended uses.

| Use | Where |
| --- | --- |
| Marketing URL | App Store Connect (optional) |
| Support URL | App Store Connect / Google Play Console (**required**; GitHub Issues is the current channel) |
| A route from submission materials | Shipaton / Devpost / #BuildInPublic posts |
| Recruiting closed-test testers | `public/beta/`. One URL for social media, schools and acquaintances |

**The only entrance for testers is the Google group (`ai-sensei@googlegroups.com`).**
That group *is* the tester list registered in Play Console, so **changing the address
removes every tester at once** (and breaks the 12 testers / 14 days count).
The group settings and the Play Console link-up are in
[`docs/ci/store-setup.md`](../../docs/ci/store-setup.md) 2-4-1.

**The LP's `#beta` and `public/beta/` have separate roles.**
`#beta` covers only what decides whether to take part (cost, what is asked of you,
what the developer can see).
**The steps - (1) join the group, (2) press the Play opt-in URL - are written only in
`public/beta/`.** Writing both scatters steps that change with Play's release state
across two places, and one will always go stale.

## Design assumptions

- **No build step, no JavaScript.** Plain HTML and CSS, working anywhere. wrangler is
  used only to serve it, never to build (it is in the pnpm workspace so `pnpm --filter`
  can run deploy).
- **`apps/mobile/lib/src/theme/tokens.dart` is authoritative for colours, corner radii
  and button weight**, and `styles.css` copies it. Drift makes it look like a
  different product beside the store screenshots. Check tokens.dart before changing.
- **The device screens are built in CSS** (the images in `docs/store/screenshots/` are
  not embedded). Embedding them would duplicate bookkeeping with the generated
  artifacts and one would always go stale. It follows the repository's policy that
  code is authoritative for visuals ([README](../../README.md)).
- **The wording comes from the app's implementation.** Headings, board formulas, the
  karte's one-liner and the paywall items match `apps/mobile/lib/src/l10n/strings.dart`.
  **Change the app's wording and change this too.**
- **No prices are written.** The amount is read from RevenueCat's Offering, so baking
  it into the page would contradict the store's checkout the moment the dashboard
  price changed (the same call as `strings.dart`'s `paywallPricePending`).
- It respects "reduce motion" ([ADR 0004](../../docs/adr.md#adr-0004)).

## Viewing it locally

```bash
pnpm --filter @ai-sensei/lp dev
# -> http://localhost:8787/      Japanese
# -> http://localhost:8787/en/   English
```

Going through wrangler reproduces production down to the `/en` -> `/en/` redirect.
Without that, a plain static server works too.

```bash
python3 -m http.server 4173 --directory apps/lp/public
```

## Publishing

```bash
pnpm --filter @ai-sensei/lp exec wrangler login   # first time only
pnpm --filter @ai-sensei/lp deploy:production
# -> https://ai-sensei-lp.<subdomain>.workers.dev
```

> **It cannot be called `deploy`.** `pnpm deploy` is pnpm's own built-in command and
> wins over a script of the same name. `pnpm --filter @ai-sensei/lp deploy` fails with
> `ERR_PNPM_INVALID_DEPLOY_TARGET This command requires one parameter`.
> `backend/api` uses `deploy:develop` / `deploy:production` for the same reason.
> (Inserting `run` avoids the built-in, but someone who does not know that hits the
> same wall typing plain `deploy`, so the name itself avoids the collision.)
>
> **Use the same name in CI deploy commands (Cloudflare Workers Builds and the like).**
> Left as `pnpm --filter @ai-sensei/lp deploy`, the build passes and only the deploy
> fails.

`build:check` (`wrangler deploy --dry-run`) checks the configuration and the upload
set first. **Always run it once before publishing** - everything in `public/` is
published as-is, so this is where you confirm the file count matches expectations.

Environments are not split. The reason, and `wrangler versions upload` for inspecting
the contents before publishing, are at the top of
[`wrangler.jsonc`](wrangler.jsonc).

For a custom domain, set `workers_dev` to `false` in `wrangler.jsonc` and add
`routes` (leaving the workers.dev URL keeps it alive as a stray URL).
For automated deploys, put the workflow where
[`docs/ci/`](../../docs/ci/README.md) says (a GitHub App cannot push to
`.github/workflows/`).

## To fill in before publishing

This pairs with "to fill in before submission" in `docs/design_direction_v0.html`.
The policy is **no links to things that do not exist**, so values stay off the page
until they are settled.

- [ ] Public domain -> change `<link rel="alternate" hreflang>` and `og:url` to
      absolute URLs (they are relative now)
- [ ] **`public/privacy/` and `public/terms/` are drafts.** Replace them after legal
      review. The `.legal-draft` block at the top of each page and the
      yellow-highlighted `<span class="fill">` mark what is undecided (operator name,
      address, contact, effective date, retention period, jurisdiction).
      **Do not publish while a single `fill` remains**
- [ ] **Settle on one authoritative copy.** The app and the store declarations point
      at `https://ubiqy.jp/privacy/` and `https://ubiqy.jp/terms/`
      (`PRIVACY_POLICY_URL` / `TERMS_URL`,
      [`../../docs/ci/store-setup.md`](../../docs/ci/store-setup.md) 0-2).
      To keep these two pages, **make the contents match** or replace them with links
      to those. Divergent wording is seen in review as a gap between the declaration
      and the real thing
- [ ] **Reconcile the wording with the store declarations.** Having written about use
      for improvement, "analytics" must be added to the purposes in App Privacy (App
      Store Connect) and Data safety (Google Play Console). The current declaration
      says only "app functionality", so fixing the wording alone gets flagged in review
- [ ] **Implement Premium's "opt out of improvement use" toggle.** Having written it
      into the terms, its absence from the app makes the terms a lie. Privacy policy
      article 4, terms article 5
- [ ] English versions of the terms and the policy. US distribution is a Shipaton
      requirement, so Japanese alone is not enough
- [ ] `SUPPORT_EMAIL` -> add it to the footer's contact (currently GitHub Issues only)
- [ ] `public/404.html` -> once added, set `not_found_handling` to `"404-page"` in
      `wrangler.jsonc`
- [ ] **Once a release is on the closed-test track, make step 2 of `public/beta/` and
      `public/en/beta/` pressable.** Concretely: remove `join-step-wait` from the
      `<li>`, replace `<span class="btn btn-soon">` with
      `<a class="btn btn-primary" href="https://play.google.com/apps/testing/jp.co.aiSensei">`,
      and delete "it will still say you are not a tester" from the `.tiny` after it.
      Until at least one release is approved, that URL only ever shows the "you are
      not a tester" screen, so do not publish it early
      ([`docs/ci/store-setup.md`](../../docs/ci/store-setup.md) 2-4-1).
      **Fix both the Japanese and English pages**
- [ ] Once live -> replace the hero and closing CTAs (currently closed beta) with real
      store badges and links. iOS ships first, so there will be a period with **only
      one live** (an App Store link plus "coming soon" for Google Play). Do not swap
      both at once. `styles.css`'s `.btn-soon` is kept for that moment
- [ ] The OGP image (`og:image`), 1200x630. **Generate it from code**, as with
      `apps/mobile/tool/`
