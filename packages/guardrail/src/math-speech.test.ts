import { describe, expect, it } from "vitest";
import { normalizeMathSpeech } from "./math-speech.ts";

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
    // 助詞は残す。式として組み直すのは写真文脈を持つLLM側の仕事。
    expect(normalize("dが大なりr")).toBe("dが>r");
  });

  it("複合した発話を直す", () => {
    expect(normalize("エックスの2乗プラス2分の1がルート3イコールワイ")).toBe("x^2+1/2が√3=y");
  });

  it("適用したルール名を返す", () => {
    expect(normalizeMathSpeech("エックスの2乗").applied).toEqual(["power-of", "var-x"]);
  });

  // やりすぎないこと。誤変換を増やすくらいなら素通しする。
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

// レビュー指摘: 「時間をかける」まで演算子にすると、カルテの材料が壊れる
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
