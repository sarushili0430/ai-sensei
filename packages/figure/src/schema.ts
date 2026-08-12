import { z } from "zod";

/**
 * 作図の宣言(モデルが書く JSON)の検査。
 *
 * **表面の書き方は `docs/figeval/spec.md` のまま**にしてある。
 * 240回の実測がその書き方で取れているので、ここで表記を変えると測り直しになる。
 *
 * ここでやるのは「解く前に、大声で落とす」こと。
 * `solve()` は解けないものを例外にするが、**知らないキーの綴り違いのように
 * 早く分かるものは、解く前に位置つきで返す**ほうが投げ直しやすい。
 */

/** 座標の上限。板書の契約({@link boardCoordinateLimit})に合わせる。 */
export const figureCoordinateLimit = 1000;

/** 1枚の図に積める要素の数。これを超える図は、板書としてもう読めない。 */
export const figureItemsMaxCount = 80;

/** 式の長さ。`x*x - 3*x + 2` のような式しか来ない前提。 */
export const figureExpressionMaxLength = 120;

/** 式に使える文字。`compile()` と同じものを、解く前にも見る。 */
const expressionPattern = /^[0-9xyt+\-*/^().,\s a-z]*$/;

/**
 * 式に書ける名前。**文字種だけを見ても足りない。**
 *
 * `alert(1)` は英小文字と括弧だけでできているので、文字種の検査は通ってしまう。
 * 式は最後に `new Function` に渡るので、**名前の許可制をこの境界にも置く**
 * (`compile()` にも同じ検査があるが、あちらは解く時点まで分からない)。
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
 * 語彙。**ここに無いキーは通さない。**
 *
 * 綴り違いを黙って無視すると、その要素だけ描かれない図ができる。
 * 描かれないことに気づけないのがいちばん困るので、名前の間違いは落とす。
 */
export const figureKeys = [
  // 点
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
  // 円・直線
  "circle",
  "center",
  "r",
  "line",
  "through",
  "perp",
  "parallel",
  "bisect",
  "perpBisect",
  // 描くもの
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
  // 座標平面・曲線
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
  // 立体
  "box3",
  "size",
  "labels",
  // 表・図式
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
  // 2次曲線の半径。**これを書き忘れていて、`conic` が丸ごと通らなくなっていた**
  // (`verify-schema.mjs` が実測の出力5件で見つけた)。
  "a",
  "b",
  // 複素数平面の操作
  "times",
  // 数直線の区間の端が閉じているか
  "closedFrom",
  "closedTo",
  // 正規分布
  "mu",
  "sigma",
  // 漸近線の傾き
  "slope",
  "intercept",
] as const;

const known = new Set<string>(figureKeys);

const finite = z.number().finite();
const coordinate = finite.min(-figureCoordinateLimit).max(figureCoordinateLimit);

/** 数の入りうる場所を、まとめて範囲で縛る。 */
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
  // 座標を直に置く `at` は、板書に載る範囲かを見る
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
  // 式は、長さと文字を先に見る(`compile()` でも見るが、位置つきで返せるのはここ)
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
 * 解く前の検査。**通らなかった理由を、キーの位置つきで返す。**
 *
 * 投げ直すときにそのまま渡せる形にしておく(先輩は自分の間違いを読めない)。
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
