import { describe, expect, it } from "vitest";
import { closingGraceMs, isClosingUtterance } from "./closing.ts";

// レビュー指摘: 締めを検出しないと、うまく終わった会話も上限時間まで
// 部屋が空回りし、ended_reason に completed が一度も立たない
describe("isClosingUtterance", () => {
  it.each([
    "ありがとうございました、助かりました",
    "ありがとうございました!",
    "助かりました。また今度きいてもいいですか?",
    "Thanks, that helped.",
  ])("締めの発話を見分ける: %s", (text) => {
    expect(isClosingUtterance(text)).toBe(true);
  });

  it.each([
    "なんでそこで判別式を使ったんですか?",
    "なるほど。",
    "もうすこし詳しく聞いてもいいですか?",
  ])("会話の途中では反応しない: %s", (text) => {
    expect(isClosingUtterance(text)).toBe(false);
  });

  it("空文字では反応しない", () => {
    expect(isClosingUtterance("   ")).toBe(false);
  });

  it("読み上げの余白を持つ(締めが途中で切れないように)", () => {
    expect(closingGraceMs).toBeGreaterThan(1000);
  });
});
