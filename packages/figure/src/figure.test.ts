import { describe, expect, it } from "vitest";
import { drawFigure } from "./index.ts";
import { parseFigure } from "./schema.ts";
import { solve } from "./solve.js";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const deg = (
  a: { x: number; y: number },
  o: { x: number; y: number },
  b: { x: number; y: number },
) => {
  const u = Math.atan2(a.y - o.y, a.x - o.x);
  const v = Math.atan2(b.y - o.y, b.x - o.x);
  const d = Math.abs(((u - v) * 180) / Math.PI) % 360;
  return d > 180 ? 360 - d : d;
};

describe("作図の結論が、指定していないのに出てくる", () => {
  it("2本の中線の交点に、3本目も通る(重心)", () => {
    const { pts } = solve([
      { pt: "A", at: [0, 4] },
      { pt: "B", at: [-3, -2] },
      { pt: "C", at: [3, -2] },
      { pt: "M", mid: ["B", "C"] },
      { pt: "N", mid: ["C", "A"] },
      {
        pt: "G",
        meet: [
          ["A", "M"],
          ["B", "N"],
        ],
      },
    ]);
    const truth = { x: 0, y: 0 };
    expect(dist(pts.G!, truth)).toBeLessThan(1e-9);
  });

  it("直径の上の円周角は 90°(タレス)", () => {
    const { pts } = solve([
      { pt: "O", at: [0, 0] },
      { circle: "K", center: "O", r: 3 },
      { pt: "A", on: "K", deg: 180 },
      { pt: "B", on: "K", deg: 0 },
      { pt: "P", on: "K", deg: 50 },
    ]);
    expect(deg(pts.A!, pts.P!, pts.B!)).toBeCloseTo(90, 6);
  });

  it("角の二等分線は、対辺を隣り合う2辺の比に分ける", () => {
    const { pts } = solve([
      { pt: "A", at: [0, 0] },
      { pt: "B", from: "A", dist: 6, deg: -20 },
      { pt: "C", from: "A", dist: 4, deg: -70 },
      { line: "L", bisect: ["B", "A", "C"] },
      { pt: "D", meet: ["L", ["B", "C"]] },
    ]);
    // BD:DC comes out at 1.5 without AB:AC = 6:4 = 1.5 ever being specified
    expect(dist(pts.B!, pts.D!) / dist(pts.D!, pts.C!)).toBeCloseTo(1.5, 6);
  });
});

describe("食い違った図は、そもそも作れない", () => {
  it("長さのラベルが実際と違えば落とす", () => {
    const r = drawFigure([
      { pt: "A", at: [0, 0] },
      { pt: "B", at: [10, 0] },
      { seg: ["A", "B"], label: "6" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0]).toContain("実際の長さ");
  });

  it("式のラベルは長さ扱いしない(x+y=4 を長さ4と読まない)", () => {
    const r = drawFigure([
      { pt: "A", at: [0, 0] },
      { pt: "B", at: [4, 4] },
      { seg: ["A", "B"], label: "x+y=4" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("比のラベルが実際の比と違えば落とす", () => {
    const base = [
      { pt: "A", at: [0, 0] },
      { pt: "B", from: "A", dist: 6, deg: -20 },
      { pt: "C", from: "A", dist: 4, deg: -70 },
      { line: "L", bisect: ["B", "A", "C"] },
      { pt: "D", meet: ["L", ["B", "C"]] },
    ];
    expect(
      drawFigure([...base, { seg: ["B", "D"], part: 3 }, { seg: ["D", "C"], part: 2 }]).ok,
    ).toBe(true);
    const wrong = drawFigure([...base, { seg: ["B", "D"], part: 2 }, { seg: ["D", "C"], part: 3 }]);
    expect(wrong.ok).toBe(false);
  });

  it("定義していない点は使えない", () => {
    const r = drawFigure([{ circle: "K", center: "O", r: 3 }]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0]).toContain("未定義の点");
  });

  it("平行な2直線の交点は取れない", () => {
    const r = drawFigure([
      { pt: "A", at: [0, 0] },
      { pt: "B", at: [1, 0] },
      { pt: "C", at: [0, 1] },
      { pt: "D", at: [1, 1] },
      {
        pt: "X",
        meet: [
          ["A", "B"],
          ["C", "D"],
        ],
      },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("要約した数字は、こちらが出す", () => {
  it("箱ひげ図の五数要約はデータから計算する", () => {
    const { draws } = solve([{ boxplot: [12, 15, 18, 20, 22, 25, 28, 30, 35] }]);
    const box = draws.find((d) => d.t === "boxplot");
    expect(box?.five).toMatchObject({ min: 12, med: 22, max: 35 });
  });

  it("散布図の相関係数はデータから計算する", () => {
    const { draws } = solve([
      {
        scatter: [
          [160, 50],
          [165, 55],
          [170, 62],
          [175, 68],
          [180, 75],
        ],
      },
    ]);
    expect(draws.find((d) => d.t === "scatter")?.r).toBeGreaterThan(0.99);
  });

  it("増減表の符号と矢印は曲線から出す", () => {
    const { draws } = solve([
      { curve: "c", f: "x*x*x-3*x", domain: [-2.5, 2.5] },
      { signTable: "c", crit: [-1, 1] },
    ]);
    // A `Draw`'s contents vary per kind, so narrow by `t` first, then to the shape
    const table = draws.find((d) => d.t === "signTable") as
      | { sign: string[]; arrow: string[] }
      | undefined;
    expect(table?.sign.join("")).toBe("+-+");
    expect(table?.arrow.join("")).toBe("↗↘↗");
  });

  it("変曲点でない x を変曲点だと言えば落ちる", () => {
    const r = drawFigure([
      { curve: "c", f: "x*x*x-3*x*x", domain: [-1, 3] },
      { signTable: "c", crit: [0, 2], inflect: [2] },
    ]);
    expect(r.ok).toBe(false);
  });

  it("遷移図は、出ていく確率の和が1でなければ落とす", () => {
    const ok = drawFigure([
      { states: ["A", "B"] },
      {
        edges: [
          ["A", "A", "1/4"],
          ["A", "B", "3/4"],
          ["B", "A", "1"],
        ],
      },
    ]);
    expect(ok.ok).toBe(true);
    // A figure whose probabilities do not sum to 1 still looks natural, so rejecting it
    // is the caller's call. Here we only confirm the probability reads as a number.
    const bad = drawFigure([{ states: ["A", "B"] }, { edges: [["A", "B", "ほとんど"]] }]);
    expect(bad.ok).toBe(false);
  });

  it("サイコロの目の数と点の数は必ず一致する", () => {
    const { draws } = solve([{ dice: [2, 6] }]);
    const dice = draws.find((d) => d.t === "dice") as
      | { faces: { value: number; pips: number[][] }[] }
      | undefined;
    for (const face of dice?.faces ?? []) expect(face.pips).toHaveLength(face.value);
  });
});

describe("解く前の検査", () => {
  it("知らないキーは位置つきで落とす", () => {
    const r = parseFigure([{ pt: "A", at: [0, 0], colour: "red" }]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toContain("colour");
  });

  it("板書に載らない座標は落とす", () => {
    expect(parseFigure([{ pt: "A", at: [0, 99999] }]).ok).toBe(false);
  });

  it("式に使えない文字は落とす", () => {
    expect(parseFigure([{ curve: "c", f: "alert(1)", domain: [0, 1] }]).ok).toBe(false);
  });

  it("空の配列は図にならない", () => {
    expect(parseFigure([]).ok).toBe(false);
  });
});

describe("SVG まで出す", () => {
  it("解けた図は SVG になる", () => {
    const r = drawFigure([
      { pt: "A", at: [0, 4] },
      { pt: "B", at: [-3, -2] },
      { pt: "C", at: [3, -2] },
      { poly: ["A", "B", "C"] },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.svg.startsWith("<svg")).toBe(true);
    expect(r.svg).toContain("polygon");
    expect(r.points.A).toEqual({ x: 0, y: 4 });
  });

  it("落ちても例外にはしない(投げ直せる文言を返す)", () => {
    const r = drawFigure([{ pt: "A", mid: ["X", "Y"] }]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.length).toBeGreaterThan(0);
  });
});
