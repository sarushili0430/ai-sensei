# @ai-sensei/figure

Solves a figure declaration (JSON) into coordinates and renders it as SVG.

```ts
import { drawFigure } from "@ai-sensei/figure";

const r = drawFigure([
  { pt: "A", at: [0, 0] },
  { pt: "B", from: "A", dist: 6, deg: -20 },
  { pt: "C", from: "A", dist: 4, deg: -70 },
  { line: "L", bisect: ["B", "A", "C"] },
  { pt: "D", meet: ["L", ["B", "C"]] },   // BD:DC = 6:4 falls out without being specified
]);
r.ok ? r.svg : r.errors;
```

## The idea

**The model writes only relations; we decide the coordinates.**
Values that must be consistent - lengths, ratios, signs, arrows, areas,
probabilities, die pips - are never written by the model, so **an inconsistent figure
cannot be produced**.

- A length label that disagrees with reality is rejected (a side labelled `"6"` that
  is actually 10 does not pass)
- Ratios are written with `part`, and the ratio between `part`s is checked against
  the real length ratio
- A sign table's signs and arrows come from the curve; only the extremum's x is passed
- A box plot's five-number summary, a scatter plot's correlation coefficient and a
  normal distribution's area are computed from the data

## Why only `solve.js` / `render.js` are JS

**Deliberately.** This is code that takes JSON of an unknown shape and throws when it
is bad, and safety comes from runtime checks (`schema.ts` and `solve()`'s own throws).
Rewriting it under `noUncheckedIndexedAccess` would only add a hundred `!`s -
**an unmeasured change to code that passes 240 measured runs**.

Types are attached to the shape visible from outside (`solve.d.ts` / `render.d.ts` /
`schema.ts`). The behaviour is pinned by the measured output:

```
node --experimental-strip-types docs/figeval/verify-port.mjs    # did the port break anything
node --experimental-strip-types docs/figeval/verify-schema.mjs  # does the contract reject the measurements
```

## Adding vocabulary

One condition: **you can write one machine-checkable invariant for it.**
The procedure and the measurements are in `docs/figeval/README.md`; the mapping to
curriculum units is in `docs/figeval/units.md`.
Forgetting to add a key to `figureKeys` makes the whole item fail, so always run
`verify-schema.mjs` (that is how the missing `a`/`b` for `conic` was found).
