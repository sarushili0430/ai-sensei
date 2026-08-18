/**
 * `solve.js` の型。
 *
 * **中身を JS のまま置いているのは意図的。** この解き手は
 * 「知らない形の JSON を受け取って、駄目なら例外にする」のが仕事で、
 * 安全は実行時の検査({@link ../schema.ts} と `solve()` 自身の throw)が担っている。
 * `noUncheckedIndexedAccess` の下で書き直すと `!` が100個増えるだけで、
 * **実測240回で通っているコードに、型のためだけの変更を入れることになる**。
 * 型は「外から見える形」に付けて、境界で守る。
 */

export type Pt = { x: number; y: number };

/** モデルが書く1要素。形は `docs/figeval/spec.md`。 */
export type Item = Record<string, unknown>;

/**
 * 解いた結果の描画命令。`t` で種類が分かれる。
 *
 * 中身は種類ごとにばらばらなので `unknown` にしてある。
 * 読む側は `t` で絞ってから、必要な形に狭める({@link render} が実際にそうしている)。
 */
export type Draw = { t: string; [key: string]: unknown };

export type Solved = {
  /** 描く順に並んだ命令。 */
  draws: Draw[];
  /** 名前のついた点。作図の結論(交点・重心など)もここに入る。 */
  pts: Record<string, Pt>;
  circles: Record<string, { c: Pt; r: number }>;
  curves: Record<string, unknown>;
  lines: Record<string, { a: Pt; b: Pt }>;
};

/**
 * 式の文字列 → 1変数の関数。**知らない名前が出たら投げる**(黙って NaN にしない)。
 */
export function compile(src: unknown, varName: string): (v: number) => number;

/** 2変数の式。領域の内外判定に使う。 */
export function compile2(src: unknown): (x: number, y: number) => number;

/**
 * 作図の宣言を座標に解く。
 *
 * **解けないものは投げる。**平行な2直線の交点、定義していない点、
 * 実際の長さと合わないラベル、和が1にならない確率 — どれも
 * 「それらしく見えて中身が違う図」になるので、描かずに落とす。
 *
 * @throws 解けなかった理由(そのまま投げ直しの材料にできる文言)
 */
export function solve(items: Item[]): Solved;
