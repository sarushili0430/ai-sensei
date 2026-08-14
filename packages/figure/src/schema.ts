import { z } from "zod";

/**
 * Validation of the figure declaration (the JSON the model writes).
 *
 * The surface syntax is kept exactly as in `docs/figeval/spec.md`. The 240
 * measured runs used that syntax, so changing the notation here would mean
 * measuring again.
 *
 * What happens here is "fail loudly before solving". `solve()` throws on anything
 * it cannot solve, but things knowable early - a misspelt key, say - are better
 * returned before solving, with a position, so they are easier to throw back.
 */

/** The coordinate limit. Matches the board contract ({@link boardCoordinateLimit}). */
export const figureCoordinateLimit = 1000;

/** How many items one figure may hold. Beyond this it is no longer readable as a board. */
export const figureItemsMaxCount = 80;

/** Expression length. The assumption is nothing longer than `x*x - 3*x + 2`. */
export const figureExpressionMaxLength = 120;

/** The characters allowed in an expression. The same set as `compile()`, checked before solving too. */
const expressionPattern = /^[0-9xyt+\-*/^().,\s a-z]*$/;

/**
 * The names an expression may use. Character classes alone are not enough.
 *
 * `alert(1)` is made only of lower-case letters and parentheses, so it passes a
 * character-class check. Expressions eventually reach `new Function`, so the
 * name allow-list is placed at this boundary too (`compile()` has the same check,
 * but that one only fires at solve time).
 */
const expressionNames = new Set([
  "x",
  "y",
  "t",
  "e",
  "pi",
  "sin",
  "cos",
  "tan",
  "sqrt",
  "abs",
  "exp",
  "log",
  "pow",
]);

/**
 * The vocabulary. Keys not listed here do not pass.
 *
 * Silently ignoring a misspelling produces a figure where that one item is simply
 * not drawn. Not noticing that it was not drawn is the worst outcome, so a wrong
 * name is rejected.
 */
export const figureKeys = [
  // Points
  "pt",
  "pts",
  "at",
  "from",
  "dist",
  "deg",
  "on",
  "onCircle",
  "onCurve",
  "byLine",
  "other",
  "along",
  "k",
  "t",
  "ratio",
  "mid",
  "centroid",
  "meet",
  "meetCircles",
  "meetCurves",
  "near",
  "hide",
  "showCoord",
  "mark",
  // Circles and lines
  "circle",
  "center",
  "r",
  "line",
  "through",
  "perp",
  "parallel",
  "bisect",
  "perpBisect",
  // Things to draw
  "seg",
  "poly",
  "fill",
  "ellipse",
  "rx",
  "ry",
  "arc",
  "right",
  "vec",
  "label",
  "part",
  "showLength",
  "dash",
  "as",
  "name",
  // Coordinate plane and curves
  "axes",
  "ticks",
  "curve",
  "f",
  "of",
  "px",
  "py",
  "domain",
  "hidden",
  "range",
  "fillUnder",
  "fillBetween",
  "to",
  "revolve",
  "around",
  "capAs",
  "asymptote",
  "riemann",
  "side",
  "n",
  "polar",
  // Solids
  "box3",
  "size",
  "labels",
  // Tables and diagrams
  "signTable",
  "crit",
  "inflect",
  "states",
  "edges",
  "seats",
  "fix",
  "balls",
  "container",
  "dice",
  "diceTable",
  "markSum",
  "markDiff",
  "numberLine",
  "ranges",
  "marks",
  "unitCircle",
  "angles",
  "region",
  "span",
  "boxplot",
  "histogram",
  "binWidth",
  "scatter",
  "tree",
  "venn",
  "counts",
  "universe",
  "lattice",
  "where",
  "normal",
  "shade",
  "conic",
  "complexPlane",
  "points",
  "ops",
  "groups",
  "terms",
  "map",
  // The conic's radius. Forgetting to list it made `conic` fail entirely
  // (found by `verify-schema.mjs` on five measured outputs).
  "a",
  "b",
  // Complex-plane operations
  "times",
  // Whether a number line's interval endpoint is closed
  "closedFrom",
  "closedTo",
  // Normal distribution
  "mu",
  "sigma",
  // The asymptote's slope
  "slope",
  "intercept",
] as const;

const known = new Set<string>(figureKeys);

const finite = z.number().finite();
const coordinate = finite.min(-figureCoordinateLimit).max(figureCoordinateLimit);

/** Bounds every place a number can appear, in one range check. */
const numericKeys = new Set([
  "r",
  "rx",
  "ry",
  "dist",
  "deg",
  "k",
  "t",
  "n",
  "binWidth",
  "markSum",
  "markDiff",
]);

const itemSchema = z.record(z.string(), z.unknown()).superRefine((item, ctx) => {
  const keys = Object.keys(item);
  if (keys.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "空の要素" });
    return;
  }
  for (const key of keys) {
    if (!known.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `知らないキー: ${key}(語彙は docs/figeval/spec.md)`,
      });
    }
  }
  // `at`, which places a coordinate directly, is checked against the board's range
  const at = item.at;
  if (Array.isArray(at)) {
    if (at.length !== 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["at"], message: "at は [x, y]" });
    } else {
      for (const [i, v] of at.entries()) {
        if (coordinate.safeParse(v).success) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["at", i],
          message: `座標が ±${figureCoordinateLimit} の外か、数でない`,
        });
      }
    }
  }
  for (const key of numericKeys) {
    if (!(key in item)) continue;
    if (finite.safeParse(item[key]).success) continue;
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} が有限の数でない` });
  }
  // Expressions are checked for length and characters first (`compile()` checks too, but only here can we report a position)
  for (const key of ["f", "px", "py", "polar", "where", "region"]) {
    const value = item[key];
    const exprs =
      key === "region"
        ? Array.isArray(value)
          ? Array.isArray(value[0])
            ? value.map((v) => (v as unknown[])[0])
            : [value[0]]
          : []
        : [value];
    for (const expr of exprs) {
      if (expr === undefined) continue;
      if (typeof expr !== "string") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} は式の文字列` });
        continue;
      }
      if (expr.length > figureExpressionMaxLength) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "式が長すぎる" });
        continue;
      }
      if (!expressionPattern.test(expr.replace(/\^/g, "**"))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `式に使えない文字がある: ${expr}`,
        });
        continue;
      }
      for (const word of expr.match(/[a-z]+/g) ?? []) {
        if (expressionNames.has(word)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `式に使えない名前がある: ${word}(使えるのは ${[...expressionNames].join(", ")})`,
        });
      }
    }
  }
});

export const figureItemsSchema = z.array(itemSchema).min(1).max(figureItemsMaxCount);
export type FigureItems = z.infer<typeof figureItemsSchema>;

/**
 * The pre-solve check. Returns the reason it failed, with the key's position.
 *
 * Kept in a form that can be thrown straight back (the senpai cannot read its own
 * mistake otherwise).
 */
export function parseFigure(
  input: unknown,
): { ok: true; items: FigureItems } | { ok: false; errors: string[] } {
  const parsed = figureItemsSchema.safeParse(input);
  if (parsed.success) return { ok: true, items: parsed.data };
  const errors = parsed.error.issues.map((issue) => {
    const where = issue.path.length ? `[${issue.path.join(".")}] ` : "";
    return `${where}${issue.message}`;
  });
  return { ok: false, errors: [...new Set(errors)].slice(0, 8) };
}
