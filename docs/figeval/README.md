# Measuring one-shot figure generation

This produced the numbers in D-18 of `docs/wireframe_board_v2.html`.
It measures **whether the figure is correct**, not whether one was drawn.

```
bash run.sh          # 8 problems x 2 models x 3 runs = 48. Raw output lands in out/
node check.mjs       # scoring
TRIALS=5 MODELS="sonnet haiku" bash run.sh    # to run more
```

Results already in `out/` are skipped, so an interrupted run resumes.

## What is here

| File | What it is |
|---|---|
| `spec.md` | The spec handed to the model (the system prompt). **This is the candidate that goes into `prompts/` as-is** |
| `units.md` | **Every high-school maths unit x the figure it needs x today's vocabulary**, with sources |
| `problems.mjs` | A typical problem per unit, plus **invariants measured mechanically from the figure** |
| `solver.mjs` | Construction -> coordinates. The same `solve()` as the wireframe (with rendering removed) |
| `check.mjs` | Scoring, in three tiers |
| `run.sh` | Runs the models |

## Why three tiers

Conflated, "works if you fix it" reads as "works".

- **`×J`** ... unreadable as JSON
- **`×voc`** ... readable, but the vocabulary is wrong or an undefined point is used
  -> **no figure appears (noticeable)**
- **`×fig`** ... a figure appears but **the geometry is wrong** -> **unnoticeable,
  and the most dangerous**
- **`○`** ... passed even the invariants

## How the problems are chosen

They measure **an amount that only holds when built by construction and collapses
when coordinates are guessed**. The median problem, for instance, only says "place G
as the intersection of two medians" and then checks **whether the third passes
through it**. If it does, the construction was assembled correctly.

## Adding vocabulary

1. Write in `units.md` which unit needs it
2. **Decide one machine-checkable invariant.** If none can be decided, do not add it
3. Add the syntax to `spec.md` (the only file the model reads)
4. Implement it in `solver.mjs`. **Values that must be consistent are computed, never
   written**
5. Add a typical problem and its invariant to `problems.mjs`
6. Confirm your own model answer passes, then run `run.sh`

**Do not skip 5 and 6.** Not skipping them is how "a figure whose length label
disagrees with the real length" was caught before shipping.

## Reading a failure

- `×voc` ... **no figure appears.** Noticeable, and usually fixed by throwing it back
  with the error text
- `×fig` ... **a figure appears with wrong contents.** The most dangerous. Suspect a
  gap in the vocabulary
- `–` ... a transport failure. Excluded from the denominator (it is not the model's score)

When `×fig` appears, **suspect the vocabulary before the model**. Most of the `×fig`
results here came from "there was no way to say it, so something close was substituted".

## A measurement pitfall (actually hit)

Starting `claude -p` inside `while read ... done < prompts.tsv` makes
**claude inherit stdin and consume the remaining problems**.
The output answers all 8 at once and the model looks like it cheated.
Close it with `</dev/null`; `run.sh` has that fix in place.
