import { describe, expect, it } from "vitest";
import { toSpeakableJa } from "./speakable.ts";

describe("toSpeakableJa", () => {
  it("角の頂点名をまとめて読む", () => {
    expect(toSpeakableJa("∠ABC と ∠A")).toBe("かくエービーシー と かくエー");
  });

  it("角度を数字から日本語にして読む", () => {
    expect(toSpeakableJa("30° と 90°")).toBe("さんじゅうど と きゅうじゅうど");
  });

  it("三角形の頂点名を読む", () => {
    expect(toSpeakableJa("△ABC")).toBe("さんかくけいエービーシー");
  });

  it("辺と比の頂点名を読む", () => {
    expect(toSpeakableJa("AB と BD:DC")).toBe("エービー と ビーディー たい ディーシー");
  });

  it("1文字の英字変数の累乗表記を読む", () => {
    expect(toSpeakableJa("x^2 と y² と a^3 と n⁴")).toBe(
      "エックスのにじょう と ワイのにじょう と エーのさんじょう と エヌのよんじょう",
    );
  });

  it("数字または1文字の英字を根号として読む", () => {
    expect(toSpeakableJa("√3 と √x と √A と √y²")).toBe(
      "ルートさん と ルートエックス と ルートエー と ルートワイのにじょう",
    );
  });

  it("英単語に紛れた累乗らしき表記や根号は壊さない", () => {
    expect(toSpeakableJa("try^2 and try²; √test, but y^2 and √x are math.")).toBe(
      "try^2 and try²; √test, but ワイのにじょう and ルートエックス are math.",
    );
  });

  it("分数は分母を先に読む", () => {
    expect(toSpeakableJa("1/2 と 2/3")).toBe("にぶんのいち と さんぶんのに");
  });

  it("関係記号を読む", () => {
    expect(toSpeakableJa("a≦b, a≧b, a≠b")).toBe("aいかb, aいじょうb, aノットイコールb");
  });

  it("矢印をだからと読む", () => {
    expect(toSpeakableJa("A→B と A⇒B")).toBe("エーだからビー と エーだからビー");
  });

  it("単独の英大文字を日本語で読む", () => {
    expect(toSpeakableJa("D と O")).toBe("ディー と オー");
  });

  it("敬称つきの英大文字は普通の日本語として保つ", () => {
    expect(toSpeakableJa("Aさんにも聞いてみよう")).toBe("Aさんにも聞いてみよう");
  });

  it("変換が要らない普通の日本語文は1文字も変えない", () => {
    const text = "まず図を見て、どの辺が対応しているか考えてみよう。";
    expect(toSpeakableJa(text)).toBe(text);
  });

  it("角度を含む発話を日本語として読める形にする", () => {
    expect(toSpeakableJa("∠ABC = 30°")).toBe("かくエービーシー イコール さんじゅうど");
  });
});
