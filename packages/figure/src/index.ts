/**
 * 作図の宣言(JSON)を座標に解き、SVG にする。
 *
 * **モデルが書くのは「関係」だけで、座標はこちらが決める。**
 * 一貫していなければならない値(長さ・比・符号・面積・確率・目の数)を
 * 書かせないので、食い違った図は作れない。
 *
 * 語彙・典型問題・実測は `docs/figeval/` にある
 * (`spec.md` がモデルに渡す仕様、`units.md` が単元との対応、
 *  `run.sh` + `check.mjs` が実測、`gallery.mjs` が実際の絵)。
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

/** {@link drawFigure} の結果。**描けたか、描けなかったかを型で分ける。** */
export type FigureResult =
  | { ok: true; svg: string; points: Record<string, { x: number; y: number }> }
  | { ok: false; errors: string[] };

/**
 * 検査 → 解く → 描く、をひとまとめにしたもの。
 *
 * **例外を投げない。**失敗した理由を文字列で返すので、
 * そのまま先輩へ投げ直せる(先輩は自分の間違いを読めないと直せない)。
 * 実測では、落ちる理由のほとんどが「順序」「語彙の綴り」「長さの食い違い」で、
 * どれも1回投げ直せば直る種類だった。
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
