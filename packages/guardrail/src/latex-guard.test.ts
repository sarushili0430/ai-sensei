import { describe, expect, it } from "vitest";
import {
  checkBoardLatex,
  collectLatexCommands,
  latexRejectionGuidance,
  latexRejectionGuidanceByLocale,
  latexRejectionReasons,
} from "./latex-guard.ts";

/**
 * Formulas confirmed to render without breaking, by eye on PNGs in the measurement
 * spike (2026-08-09).
 *
 * This list is the allow-list's evidence base, and the two must not drift.
 * Drift goes two ways, and both happened:
 *
 *   - wider than the evidence: allowing an unmeasured command -> the board vanishes
 *     on the device
 *   - narrower than the evidence: forgetting to allow something measured ->
 *     renderable formulas are thrown away by regeneration, adding only latency and
 *     cost (this really happened with `\ `, `\quad`, `\Bigl` and `\Bigr`)
 *
 * The latter was only ever caught by human review, so it is automated here.
 * When measurement adds a formula, add it to this array too.
 */
const measuredFormulas: readonly (readonly [string, string])[] = [
  ["エスケープした空白での列挙", "\\sin\\theta,\\ \\cos\\theta,\\ \\tan\\theta"],
  ["\\quad で横に並べた連立方程式", "x + y = 5,\\quad x - y = 1"],
  ["定積分の計算途中(可変サイズ括弧)", "\\int_0^1 (3x^2+2x)\\,dx = \\Bigl[x^3+x^2\\Bigr]_0^1 = 2"],
  ["二項係数(海外課程の標準記法)", "\\binom{n}{r}"],
  // Measured 2026-08-12 (rendered with `flutter_math_fork` and inspected as PNG).
  // Added because there was not one geometry symbol, and geometry units were losing
  // their whole board.
  ["接弦定理で書きたい角の等式", "\\angle CAD = \\angle ABC"],
  ["相似", "\\triangle ABC \\sim \\triangle ADE"],
  ["合同", "\\triangle ABC \\equiv \\triangle DEF"],
  ["角度の単位", "\\angle A = 90^\\circ + 30^\\circ"],
  ["平行と垂直", "AB \\parallel CD, \\quad AB \\perp EF"],
  ["かける・わる・およそ", "2 \\times 3 \\div 4 \\approx 1.5"],
  ["論証の矢印と短い綴りの不等号", "D > 0 \\Rightarrow x \\ne 0 \\Leftrightarrow x \\in A"],
  ["集合", "A \\cap B \\subset A \\cup B, \\quad \\emptyset"],
  ["上線(線分・平均)", "\\overline{AB} = 6, \\quad \\bar{x} = 5"],
  ["数列の省略", "a_1 + a_2 + \\cdots + a_n"],
  ["自動サイズの括弧", "\\left( \\frac{a}{b} \\right)"],
  ["自然対数", "\\ln x = \\log_{e} x"],
];

// Measured in the spike (2026-08-09), inspected as PNGs and rendering cleanly.
// If these start failing, the formulas the board can show have shrunk.
describe("checkBoardLatex — 実測した式が全部通る", () => {
  it.each(measuredFormulas)("%s", (_name, tex) => {
    expect(checkBoardLatex(tex)).toEqual({ ok: true });
  });
});

describe("checkBoardLatex — 通すべきもの", () => {
  it.each([
    ["二次方程式", "x^2 - 3x + 2 = 0"],
    ["判別式", "D = b^2 - 4ac = 9 - 8 = 1"],
    ["分数と根号", "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"],
    ["三乗根", "\\sqrt[3]{8} = 2"],
    ["教科書記法の組合せ", "{}_{n}\\mathrm{C}_{r} = \\frac{n!}{r!(n-r)!}"],
    ["教科書記法の順列", "{}_{5}\\mathrm{P}_{2} = 20"],
    ["総和", "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}"],
    ["定積分と細スペース", "\\int_{0}^{1} x^2 \\, dx = \\frac{1}{3}"],
    ["極限", "\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1"],
    ["ベクトル", "\\overrightarrow{AB} \\cdot \\vec{b} = 0"],
    ["不等式", "1 \\leq x \\leq 2"],
    ["集合の波括弧", "\\{ x | 1 < x < 2 \\}"],
    ["ギリシャ文字", "\\theta = \\frac{\\pi}{3}"],
    ["対数", "\\log_{2} 8 = 3"],
    // 実効幅340ptでの再実測(2026-08-09)で ∴ / ∵ の描画を確認したもの。
    ["ゆえに", "\\therefore x = 2"],
    ["なぜならば", "y = 3 \\, (\\because x = 2)"],
  ])("%s", (_name, tex) => {
    expect(checkBoardLatex(tex)).toEqual({ ok: true });
  });

  // §3-6 の注意1。単純に「\\ は未知のコマンド」で弾くと、行列も場合分けも全部落ちる。
  it("pmatrix の中の \\\\ と & で誤爆しない", () => {
    const tex = "\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}";
    expect(checkBoardLatex(tex)).toEqual({ ok: true });
  });

  it("cases の中の \\\\ と & で誤爆しない", () => {
    const tex = "x = \\begin{cases} 1 & (x > 0) \\\\ -1 & (x < 0) \\end{cases}";
    expect(checkBoardLatex(tex)).toEqual({ ok: true });
  });

  it("コマンドを含まない式は素通しする", () => {
    expect(checkBoardLatex("a = 1, b = -3, c = 2")).toEqual({ ok: true });
  });
});

describe("checkBoardLatex — 弾くべきもの", () => {
  // 移植版が対応しているか未確認のもの。「KaTeXにあるから」で通してはいけない。
  //
  // `\overparen` は 2026-08-12 に実際に描かせて**落ちた**もの
  // (`flutter_math_fork` が描けず、その行が「数式を表示できません」に化けた)。
  // 弧は `text` の板書に「弧AB」と書く。
  it.each([
    ["\\overparen(弧の記号。実測で描けなかった)", "\\overparen{AB}"],
    ["3×3の行列(実測していない)", "\\begin{bmatrix} 1 \\end{bmatrix}"],
    ["\\mathbb(実測していない)", "\\mathbb{R}"],
  ])("%s を弾く", (_name, tex) => {
    expect(checkBoardLatex(tex)).toMatchObject({ ok: false });
  });

  // A different danger from rendering: never let the board pull in external resources.
  it.each([
    ["\\href", "\\href{https://example.com}{answer}"],
    ["\\includegraphics", "\\includegraphics{answer.png}"],
    ["\\def", "\\def\\x{1}"],
  ])("%s を弾く", (_name, tex) => {
    expect(checkBoardLatex(tex)).toMatchObject({ ok: false, reason: "unknown_command" });
  });

  // Measured 2026-08-09: the "よって" in `\text{よって}` became four black bars (tofu),
  // because KaTeX's font has no Japanese glyphs. Given its own reason rather than
  // buried in unknown_command, so it can teach "wrong location - send it to a text element".
  describe("数式の中の文章 — text_in_math", () => {
    it.each([
      ["\\text での日本語", "\\text{よって} x = 2"],
      ["\\textbf", "\\textbf{Answer} = 2"],
      ["\\mbox", "\\mbox{hence} x = 2"],
    ])("%s を専用の理由で弾く", (_name, tex) => {
      expect(checkBoardLatex(tex)).toMatchObject({ ok: false, reason: "text_in_math" });
    });

    // Listing command names cannot close it. It can go inside an allowed command's argument, or bare.
    it.each([
      ["許可コマンドの引数に入れた日本語", "\\mathrm{よって} x = 2"],
      ["裸の日本語", "判別式 D > 0"],
      ["全角の読点", "x = 1、2"],
    ])("%s も弾く", (_name, tex) => {
      expect(checkBoardLatex(tex)).toMatchObject({ ok: false, reason: "text_in_math" });
    });

    it("指示は「使うな」ではなく「text 要素に送れ」になっている", () => {
      expect(latexRejectionGuidance.text_in_math).toMatch(/text/);
    });

    // An instruction ending at "write what cannot be expressed in Japanese" sends the
    // LLM back to \text{}, where it fails as text_in_math and returns to
    // unknown_command the next turn. Instructions that cycle make regeneration spin.
    // The two reasons that say where non-formula content goes must point at the same place.
    it.each(["ja", "en"] as const)("%s の指示が互いに堂々巡りしない", (locale) => {
      for (const reason of ["unknown_command", "text_in_math"] as const) {
        expect(latexRejectionGuidanceByLocale[locale][reason]).toMatch(/text/);
      }
    });
  });

  it("英字以外の1文字コマンドも見る(\\\\[a-zA-Z]+ だけでは取りこぼす)", () => {
    // `\;` is unverified. Only `\,` is allowed.
    expect(checkBoardLatex("x \\; y")).toMatchObject({ ok: false, reason: "unknown_command" });
    expect(checkBoardLatex("x \\% y")).toMatchObject({ ok: false, reason: "unknown_command" });
  });

  it("許可していない環境を弾く", () => {
    expect(checkBoardLatex("\\begin{align} a &= 1 \\end{align}")).toMatchObject({
      ok: false,
      reason: "unknown_environment",
    });
    expect(checkBoardLatex("\\begin{bmatrix} 1 \\end{bmatrix}")).toMatchObject({
      ok: false,
      reason: "unknown_environment",
    });
  });

  it("\\begin と \\end が対応していない式を弾く", () => {
    expect(checkBoardLatex("\\begin{pmatrix} 1 & 2")).toMatchObject({
      ok: false,
      reason: "unbalanced_environment",
    });
    expect(checkBoardLatex("x = 1 \\end{pmatrix}")).toMatchObject({
      ok: false,
      reason: "unbalanced_environment",
    });
  });

  // The board is one step = one line. contract bans multi-line environments, but a bare \\ slips through.
  it("環境の外の \\\\ と & を弾く", () => {
    expect(checkBoardLatex("D = 1 \\\\ x = 2")).toMatchObject({
      ok: false,
      reason: "row_separator_outside_environment",
    });
    expect(checkBoardLatex("a &= 1")).toMatchObject({
      ok: false,
      reason: "row_separator_outside_environment",
    });
  });

  // After an environment closes, we do not return to treating things as inside it.
  it("環境を閉じたあとの \\\\ を弾く", () => {
    const tex = "\\begin{cases} 1 \\\\ 2 \\end{cases} \\\\ x = 3";
    expect(checkBoardLatex(tex)).toMatchObject({
      ok: false,
      reason: "row_separator_outside_environment",
    });
  });
});

describe("collectLatexCommands", () => {
  it("環境・英字コマンド・記号コマンドを拾う", () => {
    const commands = collectLatexCommands("\\begin{cases} \\frac{1}{2} \\, \\end{cases}");
    expect(commands).toEqual(["\\begin{cases}", "\\frac", "\\,", "\\end{cases}"]);
  });
});

describe("再生成の指示", () => {
  // Given only a reason the LLM re-emits the same formula. A missing paired instruction makes regeneration spin.
  it.each(["ja", "en"] as const)("%s の指示が理由ぶん揃っている", (locale) => {
    for (const reason of latexRejectionReasons) {
      expect(latexRejectionGuidanceByLocale[locale][reason]).toBeTruthy();
    }
    expect(Object.keys(latexRejectionGuidanceByLocale[locale]).sort()).toEqual(
      [...latexRejectionReasons].sort(),
    );
  });

  it("既定は日本語", () => {
    expect(latexRejectionGuidance).toBe(latexRejectionGuidanceByLocale.ja);
  });

  it("英語の指示に日本語が混ざっていない(授業の言語が割れる)", () => {
    for (const guidance of Object.values(latexRejectionGuidanceByLocale.en)) {
      expect(guidance).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    }
  });
});
