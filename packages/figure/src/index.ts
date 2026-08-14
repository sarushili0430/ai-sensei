/**
 * Solves a figure declaration (JSON) into coordinates and renders it as SVG.
 *
 * The model writes only relations; we decide the coordinates. Values that must be
 * consistent (lengths, ratios, signs, areas, probabilities, die pips) are never
 * written by the model, so an inconsistent figure cannot be produced.
 *
 * The vocabulary, typical problems and measurements live in `docs/figeval/`
 * (`spec.md` is the spec handed to the model, `units.md` maps it to curriculum
 * units, `run.sh` + `check.mjs` do the measuring, `gallery.mjs` shows the figures).
 */
export { compile, compile2, solve } from "./solve.js";
export type { Draw, Item, Pt, Solved } from "./solve.js";
export { render } from "./render.js";
export {
  figureCoordinateLimit,
  figureExpressionMaxLength,
  figureItemsMaxCount,
  figureItemsSchema,
  figureKeys,
  parseFigure,
} from "./schema.ts";
export type { FigureItems } from "./schema.ts";

import { render } from "./render.js";
import { parseFigure } from "./schema.ts";
import { solve } from "./solve.js";

/** {@link drawFigure}'s result. Drawn versus not drawn is split in the type. */
export type FigureResult =
  | { ok: true; svg: string; points: Record<string, { x: number; y: number }> }
  | { ok: false; errors: string[] };

/**
 * Validate -> solve -> render, in one call.
 *
 * It never throws. The failure reason comes back as a string that can be thrown
 * straight back to the senpai (who cannot fix what it cannot read). In the
 * measurements, almost every failure was ordering, a misspelt vocabulary word or a
 * length mismatch - all the kind that one retry fixes.
 */
export function drawFigure(input: unknown): FigureResult {
  const parsed = parseFigure(input);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  try {
    const solved = solve(parsed.items);
    return { ok: true, svg: render(solved), points: solved.pts };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
