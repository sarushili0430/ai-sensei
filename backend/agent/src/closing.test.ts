import { describe, expect, it } from "vitest";
import { isClosingUtterance } from "./closing.ts";

// レビュー指摘: 締めを検出しないと、うまく終わった会話も上限時間まで
// 部屋が空回りし、ended_reason に completed が一度も立たない
describe("isClosingUtterance", () => {
  it.each([
    "今日はここまでにしよっか。詰め込みすぎても入らないから",
    "また来たとき、この続きやろう",
    "今日はここまでにしとこっか",
    "じゃあ今日はここまでかな",
    "今日はここまでにしよう",
    "そろそろここまでにしよっか",
    "今日はここまでにしよっか、また来たとき続きやろう",
    "今日はここまでにしよっかね",
    "また今度、この続きやろう",
    "Let's stop here for today — cramming more won't stick anyway",
    "Next time you're here, let's pick this up",
  ])("締めの発話を見分ける: %s", (text) => {
    expect(isClosingUtterance(text)).toBe(true);
  });

  it.each([
    "ここまでいい?",
    "今日はここまでいい?",
    "ここまで。",
    "なんでそこで判別式を使ったんですか?",
    "なるほど。",
    "もうすこし詳しく聞いてもいいですか?",
  ])("会話の途中では反応しない: %s", (text) => {
    expect(isClosingUtterance(text)).toBe(false);
  });

  it("空文字では反応しない", () => {
    expect(isClosingUtterance("   ")).toBe(false);
  });
});
