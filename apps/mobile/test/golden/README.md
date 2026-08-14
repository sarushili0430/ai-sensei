# golden test

Screenshot comparison of the main screens. It exists less to catch visual glitches
than to check that the design promises have not disappeared from the screen.

## CI (Linux) is authoritative for generation

Font rasterization differs per OS, so **committing PNGs generated on macOS leaves a
permanent diff against CI**. Do not commit PNGs baked locally.

Running locally is fine only to **look at the diff**:

```bash
cd apps/mobile
fvm flutter test --tags golden          # failures land in failures/
fvm flutter test --update-goldens --tags golden   # for local viewing only; do not commit
```

## Re-baking in CI

1. On GitHub, **Actions → Update goldens → Run workflow**, choosing the branch
2. Read **Show which goldens changed** in the run log to see which PNGs were rewritten
3. Download the **`goldens`** artifact
4. Put its contents into `apps/mobile/test/golden/goldens/` **as-is**
5. **Look at every image** (see below)
6. Commit them **in the same commit** as the test file (see below)

The workflow itself is [`docs/ci/golden.yml`](../../../../docs/ci/golden.yml)
(how it is copied into `.github/workflows/` is in
[`docs/ci/README.md`](../../../../docs/ci/README.md)).

### Re-baking rewrites *everything*

`--update-goldens` re-bakes **every** test tagged golden, so a change meant only for
the board can update the screen PNGs too. That is correct in itself (one shared
baseline), but expect **more images in the artifact than you touched**.

### The review step cannot be skipped

**`--update-goldens` writes whatever rendered as the new truth, unconditionally.**
Bake a broken screen and the broken screen becomes correct, and that breakage is
never detected again. A golden test can only protect what a human has looked at and
approved once.

Running `fvm flutter test --tags golden` after placing them only asks "is this the
same as what I just baked" - it is not a correctness check.

### Commit the PNGs and the test file together

When the comparison PNG is **missing**, `matchesGoldenFile` fails with "file not
found" rather than a pixel diff. Committing only the test file leaves **CI red until
the PNGs land** (pivot plan v1 §10-8).

GitHub Actions is the only effective gate for goldens. Codemagic runs macOS and
excludes them with `--exclude-tags golden` (`codemagic.yaml`). So when this is red,
**there is nowhere else to notice it**.

## When it fails

Diff images appear in `test/golden/failures/` (`*_masterImage.png` /
`*_testImage.png` / `*_isolatedDiff.png`). CI uploads them as an artifact on failure,
so they can be downloaded from there.

First check **whether your change was intended**. If it was, re-bake using the steps
above. If the diff was not intended, fix the code rather than re-baking.

## Fonts

`assets/fonts/ZenMaruGothic-*.ttf` (SIL OFL 1.1) is loaded with `loadAppFonts()`
before rendering. Without it, rendering uses Ahem (solid squares) and broken glyphs
go unnoticed.

### Note when baking board (formula) goldens

`loadAppFonts()` registers family names from `FontManifest.json` with the
`packages/xxx/` prefix **stripped** (correct for the app's own `ZenMaruGothic`, which
has no prefix). `flutter_math_fork`, however, refers to its fonts by the
**prefixed** name `'packages/flutter_math_fork/KaTeX_Main'`.

Used as-is, formulas render as **solid black squares (tofu)**. Baking that as a
golden unnoticed produces a golden with no detection power at all: **the test passes
while the real thing is garbled** (pivot plan v1 §3-6c).

Before baking a board golden, confirm that `loadAppFonts()` preserves the prefix, or
that a board-specific font loader is used.
