import { describe, expect, it } from "vitest";
import { normalizeMathSpeech, normalizeUserUtterances } from "./math-speech.ts";

const normalize = (input: string) => normalizeMathSpeech(input).text;

describe("normalizeMathSpeech", () => {
  it("累乗を ^ に直す", () => {
    expect(normalize("エックスの2乗")).toBe("x^2");
    expect(normalize("えっくすのにじょう")).toBe("x^2");
  });

  it("分数の語順を入れ替える", () => {
    expect(normalize("3分の2")).toBe("2/3");
    expect(normalize("さんぶんのに")).toBe("2/3");
  });

  it("ルートを記号に直す", () => {
    expect(normalize("ルート3")).toBe("√3");
  });

  it("三角比と対数を英字に直す", () => {
    expect(normalize("サインシータ")).toBe("sinθ");
    expect(normalize("ログ2")).toBe("log2");
  });

  it("演算子と関係記号を直す", () => {
    expect(normalize("エックスプラス3イコール5")).toBe("x+3=5");
    // Particles are kept. Reassembling it as a formula is the job of the LLM that has the photo's context.
    expect(normalize("dが大なりr")).toBe("dが>r");
  });

  it("複合した発話を直す", () => {
    expect(normalize("エックスの2乗プラス2分の1がルート3イコールワイ")).toBe("x^2+1/2が√3=y");
  });

  it("適用したルール名を返す", () => {
    expect(normalizeMathSpeech("エックスの2乗").applied).toEqual(["power-of", "var-x"]);
  });

  // Do not overreach. Passing text through beats adding mis-conversions.
  it("普通の日本語は壊さない", () => {
    const sentences = [
      "そこはなんとなくで進めました",
      "円の中心から直線までの距離を求めました",
      "先生に聞いたやり方でやりました",
    ];
    for (const sentence of sentences) {
      expect(normalize(sentence)).toBe(sentence);
    }
  });

  it("「わかった」を割る記号に変えない", () => {
    expect(normalize("そこでやっとわかりました")).toBe("そこでやっとわかりました");
  });

  it("変換対象がなければ applied は空", () => {
    expect(normalizeMathSpeech("だいたい合っていると思います").applied).toEqual([]);
  });
});

describe("normalizeUserUtterances", () => {
  it("ユーザーの発話だけを正規化し、後輩の発話は触らない", () => {
    const messages = [
      { role: "assistant", text: "エックスの2乗の話ですよね?" },
      { role: "user", text: "はい、エックスの2乗です" },
    ];
    const normalized = normalizeUserUtterances(messages);
    expect(normalized[0]?.text).toBe("エックスの2乗の話ですよね?");
    expect(normalized[1]?.text).toBe("はい、x^2です");
  });
});

// From review: making even "時間をかける" an operator would corrupt the karte's raw material
describe("日常語の「かける」「わる」", () => {
  it("時間をかける、は演算子にしない", () => {
    expect(normalize("この計算には時間をかける必要があります")).toBe(
      "この計算には時間をかける必要があります",
    );
  });

  it("数と数のあいだのかけるは演算子にする", () => {
    expect(normalize("2かける3")).toBe("2×3");
    expect(normalize("6わる2")).toBe("6÷2");
  });

  it("式の途中でなければ触らない", () => {
    expect(normalize("手間をわるく見積もっていました")).toBe("手間をわるく見積もっていました");
  });
});

// English STT also transcribes readings literally ("x squared").
// Words that collide with everyday use (times / over / plus) are fixed only when both sides are terms.
describe("英語の読み替え", () => {
  const en = (input: string) => normalizeMathSpeech(input, "en").text;

  it("累乗と根号を記号にする", () => {
    expect(en("x squared minus 4x plus k")).toBe("x^2 - 4x + k");
    expect(en("y cubed")).toBe("y^3");
    expect(en("the square root of 3")).toBe("the √3");
    expect(en("2 to the power of 5")).toBe("2^5");
  });

  it("数どうしの分数と演算子を記号にする", () => {
    expect(en("3 over 4")).toBe("3/4");
    expect(en("6 divided by 2 equals 3")).toBe("6 ÷ 2 = 3");
    expect(en("2 times 3")).toBe("2 × 3");
  });

  it("日常語まで演算子にしない", () => {
    expect(en("I went over the working three times")).toBe("I went over the working three times");
    expect(en("that takes a plus side")).toBe("that takes a plus side");
  });

  it("ギリシャ文字の読みを記号にする", () => {
    expect(en("sin theta plus pi")).toBe("sin θ + π");
  });

  it("日本語のルールを英語の発話に当てない(既定はja)", () => {
    expect(normalizeMathSpeech("x squared").text).toBe("x squared");
    expect(normalizeMathSpeech("x squared", "en").applied).toContain("en-squared");
  });
});
