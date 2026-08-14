/**
 * Types for `solve.js`.
 *
 * Keeping the implementation in JS is deliberate. This solver's job is to take
 * JSON of an unknown shape and throw when it is bad, and safety comes from runtime
 * checks ({@link ../schema.ts} and `solve()`'s own throws). Rewriting it under
 * `noUncheckedIndexedAccess` would only add a hundred `!`s - a change made purely
 * for types to code that passes 240 measured runs. Types go on the shape visible
 * from outside, and the boundary does the guarding.
 */

export type Pt = { x: number; y: number };

/** One item the model writes. Its shape is in `docs/figeval/spec.md`. */
export type Item = Record<string, unknown>;

/**
 * A draw instruction from the solved result. `t` distinguishes the kinds.
 *
 * The contents vary per kind, so they are `unknown`. Readers narrow by `t` first
 * and then to the shape they need (which is what {@link render} does).
 */
export type Draw = { t: string; [key: string]: unknown };

export type Solved = {
  /** The instructions, in draw order. */
  draws: Draw[];
  /** Named points. A construction's conclusions (intersections, centroids) land here too. */
  pts: Record<string, Pt>;
  circles: Record<string, { c: Pt; r: number }>;
  curves: Record<string, unknown>;
  lines: Record<string, { a: Pt; b: Pt }>;
};

/**
 * Expression string -> a one-variable function. Throws on an unknown name (never silently NaN).
 */
export function compile(src: unknown, varName: string): (v: number) => number;

/** A two-variable expression. Used to decide inside/outside a region. */
export function compile2(src: unknown): (x: number, y: number) => number;

/**
 * Solves a figure declaration into coordinates.
 *
 * Anything unsolvable throws: the intersection of two parallel lines, an undefined
 * point, a label that disagrees with the real length, probabilities that do not sum
 * to 1 - each would produce a figure that looks plausible but is wrong, so it fails
 * rather than being drawn.
 *
 * @throws the reason it could not be solved (wording usable directly as retry material)
 */
export function solve(items: Item[]): Solved;
