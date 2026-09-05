import { describe, expect, it } from "vitest";
import {
  checkProblemText,
  problemRejectionGuidance,
  problemRejectionGuidanceByLocale,
  problemRejectionReasons,
} from "./problem-guard.ts";

/**
 * **通すほうが長いのは意図。**
 * 正当な問題文を落とすと `problem_text` が空になり、先輩は「(問題の写真なし)」から
 * 始める = **問題が写っているのに見ないまま教える**、いちばん避けたかった状態に戻る。
 * だから「迷ったら通す」で、ここが実質的な仕様書になる。
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
   * 設問の中の「解答」「答え」を巻き込まない。見出しは囲みかコロンを伴うので、
   * そこを必須にしてある。ここが緩むと、**ごくふつうの設問**が落ちはじめる。
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
   * 問題集の紙面には、生徒が解く前から**空欄の解答欄**が印刷されている。
   * 「Answer:」があるだけでは、解答が混ざった証拠にならない。
   */
  it("空欄の解答欄の見出しだけでは落とさない", () => {
    expect(checkProblemText("Solve for x.  x + 3 = 7\nAnswer: ______").ok).toBe(true);
  });

  // sin / cos / log は3文字なので散文として通る。**それでよい**(迷ったら通す)。
  it("関数名しか無くても通す(明らかに設問でない断片だけを落とす)", () => {
    expect(checkProblemText("sin(x) + cos(x) = 1").ok).toBe(true);
  });
});

describe("checkProblemText — 弾くべきもの", () => {
  /**
   * ここが塞ぎたかった穴。紙面の下半分に章末の解答が写ると、
   * 解答まで問題文として流れ込み、**先輩が解き方を組み立てずに答えを写す**。
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

  // ∴ は設問には出ず、解答の途中にしか出ない。
  it("ゆえに(∴)が入っていれば落とす", () => {
    expect(checkProblemText("D = 9 - 8 = 1 > 0 ∴ 異なる2つの実数解")).toMatchObject({
      ok: false,
      reason: "solution_included",
    });
  });

  /**
   * 「何を問われているか」が書かれていない断片。
   * 式だけを渡されても、先輩は何を教えればいいか決められない。
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

/**
 * **手入力(`PATCH /v1/sessions/{id}/problem`)にだけ効く一段。**
 *
 * 写真の書き起こしで裸の `Answer:` を通しているのは、紙面に**解く前から
 * 空欄の解答欄が印刷されている**から。生徒が自分で打った本文には、その理由が立たない。
 */
describe("checkProblemText — 手入力のときだけ厳しく見る", () => {
  it.each([
    "Solve x + 3 = 7. Answer: x = 4",
    "xを求めよ。答え: 4",
    "次の方程式を解け。\n答: x = 1, 2",
    "Find the roots.\nAns: 1 and 2",
  ])("打ち込まれた答えを落とす: %s", (text) => {
    expect(checkProblemText(text, "manual")).toMatchObject({
      ok: false,
      reason: "solution_included",
    });
    // **写真の側は変えない。** ここを厳しくすると、紙面の空欄の解答欄が
    // 写っただけで問題文が null に戻る(= 問題を見ないまま教える)。
    expect(checkProblemText(text).ok).toBe(true);
  });

  /**
   * 空欄のままの見出しは、手入力でも通す。
   * 打ってきた人まで弾くと、見ているのが「答えがあるか」ではなく
   * 「解答欄の体裁を写したか」になってしまう。
   */
  it.each([
    "Solve for x.  x + 3 = 7\nAnswer: ______",
    "xを求めよ。\n答え:",
    "xを求めよ。\n答え: ___",
  ])("空欄の解答欄は手入力でも通す: %s", (text) => {
    expect(checkProblemText(text, "manual").ok).toBe(true);
  });

  // 設問の中の「答え」は、コロンが無いので巻き込まれない。
  it.each([
    "答えは小数第2位を四捨五入して求めよ。",
    "答えを整数で求めよ。",
    "解答用紙に途中式も書くこと。x^2 - 3x + 2 = 0 を解け。",
    "Answer the following questions about the graph of y = x^2.",
  ])("設問の中の「答え」は手入力でも巻き込まない: %s", (text) => {
    expect(checkProblemText(text, "manual").ok).toBe(true);
  });

  // 既定は写真。**渡し忘れたら緩いほうへ倒れる**(厳しいほうを既定にすると、
  // 写真経路で正当な問題文を落として「見ないまま教える」に戻る)。
  it("既定は写真の側(緩いほう)", () => {
    expect(checkProblemText("xを求めよ。答え: 4")).toEqual(
      checkProblemText("xを求めよ。答え: 4", "photo"),
    );
  });

  // 写真の側で落ちるものは、手入力でも当然落ちる。
  it("写真の側の見出しは、手入力でも落ちる", () => {
    expect(checkProblemText("x^2 - 3x + 2 = 0 を解け。 【解答】x = 1, 2", "manual")).toMatchObject({
      ok: false,
      reason: "solution_included",
    });
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
   * 宛先は**写真解析のプロンプト**。直すのは「紙面のどこを書き写すか」なので、
   * 指示も取る範囲を名指しする形でなければ、解析器は同じ書き起こしを出し直す。
   */
  it("解答混入の指示が、取らない場所を名指ししている", () => {
    expect(problemRejectionGuidanceByLocale.ja.solution_included).toContain("設問だけ");
    expect(problemRejectionGuidanceByLocale.en.solution_included).toContain("only the question");
  });

  // 設問が写っていないなら空文字。ここを推測で埋めると、存在しない問題を教える。
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
