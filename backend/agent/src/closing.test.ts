import { describe, expect, it } from "vitest";
import { isClosingUtterance } from "./closing.ts";

// From review: without closing detection, a well-finished conversation idles
// until the cap and ended_reason never becomes completed
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
    "今日の授業はここまでにしよっか",
    "じゃあ今日はここまでかな？",
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

  // From review: "ここまで" also marks the end of an explanation. Mistaking it for a
  // close shuts the room mid-lesson - worse than not detecting it at all
  it.each([
    "説明はここまでかな?じゃあ次は円の方程式ね",
    "この説明はここまでにしとこっか。つぎは問題を解いてみよう",
    "今日は二次関数やったね。説明はここまでかな?",
    "ここまでかなり進んだね",
  ])("話の区切りでは反応しない: %s", (text) => {
    expect(isClosingUtterance(text)).toBe(false);
  });

  it("空文字では反応しない", () => {
    expect(isClosingUtterance("   ")).toBe(false);
  });
});
