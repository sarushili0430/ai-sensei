import { describe, expect, it } from "vitest";
import { figureQualityFixtures, readableFigureFixture } from "./quality-fixtures.js";
import {
  figureMaxOverflowPx,
  figureRelationsPreserved,
  lintFigure,
  repairFigure,
} from "./quality.js";
import { solve } from "./solve.js";

describe("solve後の図品質lint", () => {
  for (const fixture of figureQualityFixtures) {
    it(`${fixture.id} を ${fixture.invariant} として検出する`, () => {
      const report = lintFigure(solve(fixture.items));

      expect(report.ok).toBe(false);
      const issue = report.issues.find((candidate) => candidate.invariant === fixture.invariant);
      expect(issue).toBeDefined();
      expect(issue?.deficit).toBeGreaterThan(0);
      expect(issue?.actual).toBeGreaterThanOrEqual(0);
    });
  }

  it("正常な三角形は弾かない", () => {
    expect(lintFigure(solve(readableFigureFixture))).toMatchObject({ ok: true, issues: [] });
  });

  /**
   * **2次曲線は `a` / `b` からは描画範囲が読めない。**
   *
   * `render.js` は双曲線を `t = ±1.4` までサンプリングし、漸近線はさらに外へ伸ばす。
   * 走査から落とすと、実際には上下へ30px近く出ている図が `maxOverflowPx: 0` として
   * 通り、**切れたグラフがそのまま生徒に届く**。
   */
  it("2次曲線のはみ出しを見落とさない", () => {
    const hyperbola = lintFigure(solve([{ conic: "hyperbola", a: 3, b: 4 }]));

    expect(hyperbola.metrics.maxOverflowPx).toBeGreaterThan(figureMaxOverflowPx);
    expect(hyperbola.issues.some((issue) => issue.invariant === "viewbox_overflow")).toBe(true);

    // 収まる2次曲線まで弾かないこと(偽陽性)。
    expect(lintFigure(solve([{ conic: "ellipse", a: 4, b: 3 }])).metrics.maxOverflowPx).toBe(0);
    expect(lintFigure(solve([{ conic: "parabola", a: 2 }])).metrics.maxOverflowPx).toBe(0);
  });
});

describe("関係を保つ決定的な自動修正", () => {
  for (const fixture of figureQualityFixtures) {
    it(`${fixture.id} を再solveして解消する`, () => {
      const original = structuredClone(fixture.items);
      const repaired = repairFigure(fixture.items);

      expect(repaired.ok).toBe(true);
      expect(repaired.quality).toMatchObject({ ok: true, issues: [] });
      expect(figureRelationsPreserved(fixture.items, repaired.items)).toBe(true);
      // 入力はLLMの宣言そのものなので、修正中に破壊しない。
      expect(fixture.items).toEqual(original);
      // 同じ入力なら候補順もラベル方角も同じ。乱数を入れない約束をSVG手前で固定する。
      expect(repairFigure(fixture.items)).toEqual(repaired);
    });
  }

  it("正常な図には座標の修正を加えない", () => {
    const repaired = repairFigure(readableFigureFixture);

    expect(repaired.ok).toBe(true);
    expect(repaired.repaired).toBe(false);
    expect(repaired.items).toBe(readableFigureFixture);
    expect(repaired.changes).toEqual([]);
  });

  /**
   * **見栄えの修正で幾何の主張を書き換えない。**
   *
   * 宣言の字面(`figureRelationsPreserved`)は `at` を置き直しても一致するので、
   * それだけを通すと直角マークの中身が90°から70°へ動き、マークだけが残る。
   * 崩れた図より悪い「こちらが作った、生徒が気づけない誤り」なので、
   * 直せないほうへ倒して作り直しの guidance へ渡す。
   */
  it("直角マークのある図では、角度を変える修正を採らない", () => {
    const angleAt = (
      points: Record<string, { x: number; y: number }>,
      o: string,
      a: string,
      b: string,
    ) => {
      const origin = points[o] as { x: number; y: number };
      const first = points[a] as { x: number; y: number };
      const second = points[b] as { x: number; y: number };
      const dot =
        (first.x - origin.x) * (second.x - origin.x) + (first.y - origin.y) * (second.y - origin.y);
      const lengths =
        Math.hypot(first.x - origin.x, first.y - origin.y) *
        Math.hypot(second.x - origin.x, second.y - origin.y);
      return (Math.acos(Math.max(-1, Math.min(1, dot / lengths))) * 180) / Math.PI;
    };
    // A が直角。C が A に寄っていて、最小角の不変量には引っかかる。
    const flatRightTriangle = [
      { pt: "A", at: [0, 0] },
      { pt: "B", at: [6, 0] },
      { pt: "C", at: [0, 0.35] },
      { seg: ["A", "B"] },
      { seg: ["B", "C"] },
      { seg: ["C", "A"] },
      { right: ["B", "A", "C"] },
    ];

    const repaired = repairFigure(flatRightTriangle);

    expect(repaired.ok).toBe(false);
    expect(angleAt(repaired.solved.pts, "A", "B", "C")).toBeCloseTo(90, 1);
    expect(repaired.changes).not.toContain("anchor_resampling");

    // 直角の主張が無い同じ形なら、従来どおり座標を置き直して直す。
    const withoutRightAngleMark = flatRightTriangle.filter((item) => !("right" in item));
    expect(repairFigure(withoutRightAngleMark)).toMatchObject({ ok: true, repaired: true });
  });

  /**
   * **数値ラベルの付いた角マークも、直角マークと同じ「幾何の主張」。**
   *
   * `{arc:[...], label:"1.43°"}` は画面に角度を書いているので、座標を置き直すと
   * 中身だけ70°になってラベルが嘘になる。`θ` のような記号名は値を主張していないので
   * 動かしてよい —— 長さラベルを数値かどうかで見分けるのと同じ切り方。
   */
  it("数値ラベルの角マークは守り、記号ラベルなら従来どおり直す", () => {
    const flat = [
      { pt: "A", at: [0, 0] },
      { pt: "B", at: [6, 0] },
      { pt: "C", at: [4, 0.1] },
      { seg: ["A", "B"] },
      { seg: ["B", "C"] },
      { seg: ["C", "A"] },
    ];

    expect(repairFigure([...flat, { arc: ["B", "A", "C"], label: "1.43°" }])).toMatchObject({
      ok: false,
      repaired: false,
    });
    expect(repairFigure([...flat, { arc: ["B", "A", "C"], label: "θ" }])).toMatchObject({
      ok: true,
      repaired: true,
    });
  });
});
