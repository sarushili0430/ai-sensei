import { describe, expect, it } from "vitest";
import {
  checkBoardLatex,
  collectLatexCommands,
  latexRejectionGuidance,
  latexRejectionGuidanceByLocale,
  latexRejectionReasons,
} from "./latex-guard.ts";

/**
 * 実測スパイク(2026-08-09)でPNGを目視し、**崩れずに描けたことを確認した式**。
 *
 * このリストが許可リストの**証拠ベース**で、両者はずれてはいけない。
 * ずれ方は2方向あって、どちらも起きた:
 *
 *   - 証拠より**広い**: 実測していないコマンドを許可した → 端末で板書が消える
 *   - 証拠より**狭い**: 実測したのに許可し忘れた → 描ける式が再生成で捨てられ、
 *     レイテンシと原価だけ増える(`\ ` `\quad` `\Bigl` `\Bigr` で実際に起きた)
 *
 * **後者は人間のレビューでしか見つからなかった**ので、ここで自動化する。
 * 実測で式を足したら、この配列にも足すこと。
 */
const measuredFormulas: readonly (readonly [string, string])[] = [
  ["エスケープした空白での列挙", "\\sin\\theta,\\ \\cos\\theta,\\ \\tan\\theta"],
  ["\\quad で横に並べた連立方程式", "x + y = 5,\\quad x - y = 1"],
  ["定積分の計算途中(可変サイズ括弧)", "\\int_0^1 (3x^2+2x)\\,dx = \\Bigl[x^3+x^2\\Bigr]_0^1 = 2"],
  ["二項係数(海外課程の標準記法)", "\\binom{n}{r}"],
];

// 実測スパイク(2026-08-09)でPNGを目視し、崩れずに描けたもの。
// ここが落ちるようになったら、板書に出せる式が減っている。
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
  it.each([
    ["\\ln(\\log は許可、\\ln は未検証)", "\\ln x = 1"],
    ["\\overline", "\\overline{AB} = 5"],
    ["\\left \\right の可変括弧", "\\left( \\frac{1}{2} \\right)"],
  ])("%s を弾く", (_name, tex) => {
    expect(checkBoardLatex(tex)).toMatchObject({ ok: false, reason: "unknown_command" });
  });

  // 描画とは別の危険。板書に外部リソースを引き込ませない。
  it.each([
    ["\\href", "\\href{https://example.com}{answer}"],
    ["\\includegraphics", "\\includegraphics{answer.png}"],
    ["\\def", "\\def\\x{1}"],
  ])("%s を弾く", (_name, tex) => {
    expect(checkBoardLatex(tex)).toMatchObject({ ok: false, reason: "unknown_command" });
  });

  // 実測(2026-08-09): `\text{よって}` の「よって」が4本の黒い棒(tofu)になった。
  // KaTeXのフォントが日本語グリフを持たないため。unknown_command に埋もれさせず、
  // 「置き場所が違う(text要素に送れ)」と教えるための専用の理由。
  describe("数式の中の文章 — text_in_math", () => {
    it.each([
      ["\\text での日本語", "\\text{よって} x = 2"],
      ["\\textbf", "\\textbf{Answer} = 2"],
      ["\\mbox", "\\mbox{hence} x = 2"],
    ])("%s を専用の理由で弾く", (_name, tex) => {
      expect(checkBoardLatex(tex)).toMatchObject({ ok: false, reason: "text_in_math" });
    });

    // コマンド名の列挙だけでは塞げない。許可コマンドの引数にも、裸でも入れられる。
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

    // 「表せないものは日本語で書くこと」で終える指示は、LLMを \text{} に戻す。
    // そこで text_in_math に落ち、次のターンでまた unknown_command に戻る。
    // **指示どうしが循環すると再生成が空回りする。**
    // 「数式にできないものをどこへ送るか」を言う2つの理由は、同じ行き先を指すこと。
    it.each(["ja", "en"] as const)("%s の指示が互いに堂々巡りしない", (locale) => {
      for (const reason of ["unknown_command", "text_in_math"] as const) {
        expect(latexRejectionGuidanceByLocale[locale][reason]).toMatch(/text/);
      }
    });
  });

  it("英字以外の1文字コマンドも見る(\\\\[a-zA-Z]+ だけでは取りこぼす)", () => {
    // `\;` は未検証。`\,` だけを許可している。
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

  // 板書は1手順=1行。contract は多行環境を禁止しているが、裸の \\ は素通りする。
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

  // 環境を閉じたあとは、内側の扱いに戻らない。
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
  // 理由だけ渡してもLLMは同じ式を出し直す。対の指示が欠けると再生成が空回りする。
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
