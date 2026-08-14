import { describe, expect, it } from "vitest";
import {
  checkProblemText,
  problemRejectionGuidance,
  problemRejectionGuidanceByLocale,
  problemRejectionReasons,
} from "./problem-guard.ts";

/**
 * That the pass list is longer is deliberate.
 * Rejecting a legitimate problem text empties `problem_text` and the senpai starts
 * from "(no problem photo)" = teaching without looking at a problem that is right
 * there, the very state we wanted to avoid. So the rule is "when unsure, let it
 * through", and this file is effectively the specification.
 */
describe("checkProblemText — 通すべきもの", () => {
  it.each([
    "円 x^2 + y^2 = 5 と直線 y = x + k について、(1) 共有点の個数を求めよ。",
    "次の2次不等式を解け。 x^2 - 3x + 2 < 0",
    "△ABCにおいて、a = 3, b = 5, C = 60° のとき c を求めよ。",
    "Solve the inequality x^2 - 3x + 2 < 0.",
    "For the circle x^2 + y^2 = 5 and the line y = x + k, find the number of intersection points.",
    "Prove that the sum of the angles of a triangle is 180 degrees.",
  ])("%s", (text) => {
    expect(checkProblemText(text).ok).toBe(true);
  });

  /**
   * "解答" and "答え" inside a question are not caught. Headings always carry a bracket
   * or a colon, so that is required. Loosen it and perfectly ordinary questions start
   * being rejected.
   */
  it.each([
    "解答用紙に途中式も書くこと。x^2 - 3x + 2 = 0 を解け。",
    "答えは小数第2位を四捨五入して求めよ。",
    "解答欄に記入せよ。",
    "答えを整数で求めよ。",
    "Answer the following questions about the graph of y = x^2.",
  ])("設問の中の「解答/答え」は巻き込まない: %s", (text) => {
    expect(checkProblemText(text).ok).toBe(true);
  });

  /**
   * Workbook pages print a blank answer box before the student solves anything.
   * The presence of "Answer:" alone is no evidence of a mixed-in answer.
   */
  it("空欄の解答欄の見出しだけでは落とさない", () => {
    expect(checkProblemText("Solve for x.  x + 3 = 7\nAnswer: ______").ok).toBe(true);
  });

  // sin / cos / log are three letters and pass as prose. That is fine (when unsure, let it through).
  it("関数名しか無くても通す(明らかに設問でない断片だけを落とす)", () => {
    expect(checkProblemText("sin(x) + cos(x) = 1").ok).toBe(true);
  });
});

describe("checkProblemText — 弾くべきもの", () => {
  /**
   * The hole this closes. When the chapter's answers appear in the lower half of the
   * page, they flow in as problem text and the senpai copies the answer instead of
   * building the method.
   */
  it.each([
    "x^2 - 3x + 2 = 0 を解け。 【解答】x = 1, 2",
    "次の方程式を解け。 [解説] 因数分解すると (x-1)(x-2) = 0",
    "円と直線の共有点を求めよ。\n解答: 2個",
    "(解) 判別式 D = 1 > 0 より異なる2つの実数解をもつ",
    "Solve the equation. [Solution] x = 1 or x = 2",
    "Find the roots.\nSolution: x = 1, x = 2",
  ])("解答が混ざった問題文を落とす: %s", (text) => {
    expect(checkProblemText(text)).toMatchObject({
      ok: false,
      reason: "solution_included",
    });
  });

  // ∴ never appears in a question, only mid-solution.
  it("ゆえに(∴)が入っていれば落とす", () => {
    expect(checkProblemText("D = 9 - 8 = 1 > 0 ∴ 異なる2つの実数解")).toMatchObject({
      ok: false,
      reason: "solution_included",
    });
  });

  /**
   * A fragment that does not say what is being asked.
   * Handed only a formula, the senpai cannot decide what to teach.
   */
  it.each(["x^2 - 3x + 2 = 0", "y = x + k", "(1) (2) (3)", "2x + 3 = 7"])(
    "式だけの断片を落とす: %s",
    (text) => {
      expect(checkProblemText(text)).toMatchObject({ ok: false, reason: "not_a_problem" });
    },
  );

  it("空白だけの問題文を落とす", () => {
    expect(checkProblemText("   \n  ")).toMatchObject({ ok: false, reason: "not_a_problem" });
  });
});

describe("再生成の指示", () => {
  it("すべての理由に、両方の言語の指示がある", () => {
    for (const locale of ["ja", "en"] as const) {
      for (const reason of problemRejectionReasons) {
        expect(
          problemRejectionGuidanceByLocale[locale][reason].length,
          `${locale}/${reason}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(problemRejectionGuidance).toBe(problemRejectionGuidanceByLocale.ja);
  });

  /**
   * The audience is the photo-analysis prompt. What needs fixing is which part of the
   * page to transcribe, so unless the instruction names the range to capture, the
   * analyser re-emits the same transcription.
   */
  it("解答混入の指示が、取らない場所を名指ししている", () => {
    expect(problemRejectionGuidanceByLocale.ja.solution_included).toContain("設問だけ");
    expect(problemRejectionGuidanceByLocale.en.solution_included).toContain("only the question");
  });

  // No question in shot means an empty string. Filling it by guesswork teaches a problem that does not exist.
  it("設問なしの指示が、空文字にする逃げ道を示している", () => {
    expect(problemRejectionGuidanceByLocale.ja.not_a_problem).toContain("空文字");
    expect(problemRejectionGuidanceByLocale.en.not_a_problem).toContain("empty string");
  });

  it("英語の指示に日本語が混ざらない", () => {
    for (const reason of problemRejectionReasons) {
      expect(problemRejectionGuidanceByLocale.en[reason], reason).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    }
  });
});
