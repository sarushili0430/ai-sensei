import { describe, expect, it } from "vitest";
import { findUncertaintyUtterances, isUncertaintyUtterance } from "./uncertainty.ts";

describe("isUncertaintyUtterance", () => {
  it("「わからない」の言い方をひととおり拾う", () => {
    for (const said of [
      "わからないです",
      "わかんないです",
      "分からないです",
      "わかりません",
      "そこは知らないです",
      "そこはまだ習ってないです",
      "忘れました",
      "うまく言えないです",
      "説明できません",
      "類題はできなかった",
      "そこは……なんとなくです",
      "ちょっと自信ないです",
    ]) {
      expect(isUncertaintyUtterance(said), said).toBe(true);
    }
  });

  it("画面の「うまく言えない」を押したときの合図も拾う", () => {
    expect(isUncertaintyUtterance("うまく言えません。ちがう聞き方をしてもらえますか?")).toBe(true);
  });

  it("類題の「できなかった」を穴の evidence として拾う", () => {
    expect(isUncertaintyUtterance("できなかった")).toBe(true);
    expect(isUncertaintyUtterance("できません")).toBe(true);
    expect(isUncertaintyUtterance("解けませんでした")).toBe(true);
    expect(isUncertaintyUtterance("I couldn't do it")).toBe(true);
    expect(isUncertaintyUtterance("I can't solve it")).toBe(true);
    expect(isUncertaintyUtterance("できた")).toBe(false);
    expect(isUncertaintyUtterance("できないことはない")).toBe(false);
  });

  it("英語ロケールの言い方も拾う", () => {
    expect(isUncertaintyUtterance("I don't know, sorry")).toBe(true);
    expect(isUncertaintyUtterance("No idea")).toBe(true);
  });

  // 言えたことを穴として記録するほうが、取りこぼしよりわるい。
  it("説明できているものを穴にしない", () => {
    for (const said of [
      "中心と直線の距離を半径と比べました",
      "わかりました、そこは距離で判定します",
      "判別式が0だから接します",
      "",
      "   ",
    ]) {
      expect(isUncertaintyUtterance(said), said).toBe(false);
    }
  });

  it("肯定の中に否定の形が出てくる文を取り違えない", () => {
    expect(isUncertaintyUtterance("わからないことがわかりました")).toBe(false);
    expect(isUncertaintyUtterance("そこはわからなくなかったです")).toBe(false);
  });
});

describe("findUncertaintyUtterances", () => {
  it("ユーザーの発話だけを、言われた順に返す", () => {
    expect(
      findUncertaintyUtterances([
        { role: "assistant", text: "なんで判別式を使ったんですか?" },
        { role: "user", text: "そこはわからないです" },
        { role: "assistant", text: "ぼくもわからないので、一緒に覚えておきますね" },
        { role: "user", text: "距離で比べました" },
        { role: "user", text: "接するときは忘れました" },
      ]),
    ).toEqual(["そこはわからないです", "接するときは忘れました"]);
  });

  // 後輩は「わからない」が持ち役なので、拾うと毎回ヒットしてしまう。
  it("後輩の発話は拾わない", () => {
    expect(
      findUncertaintyUtterances([
        { role: "assistant", text: "判別式って何がわかるものなんですか?わからなくて" },
      ]),
    ).toEqual([]);
  });
});
