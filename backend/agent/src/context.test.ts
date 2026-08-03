import { describe, expect, it } from "vitest";
import { InvalidSessionContextError, readSessionContext, remainingSeconds } from "./context.ts";

const metadata = JSON.stringify({
  session_id: "ses_1",
  locale: "ja",
  kind: "new",
  max_seconds: 300,
  photo_summary: "円と直線の位置関係の問題",
  visible_work: "- 中心と直線の距離を求めている",
  question_seeds: "- 方法を変えた理由",
  allowed_topics: "- M2-ZUKEI-ENCHOKU — 数学II / 図形と方程式 / 円と直線の位置関係",
  allowed_topic_ids: ["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"],
  is_premium: false,
});

describe("readSessionContext", () => {
  it("トークンのmetadataから会話文脈を読む", () => {
    const context = readSessionContext(metadata);
    expect(context.session_id).toBe("ses_1");
    expect(context.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
    expect(context.max_seconds).toBe(300);
  });

  // 文脈なしで喋らせると、写真と関係ない一般論を聞き始めてしまう
  it("metadataが空なら会話を始めない", () => {
    expect(() => readSessionContext(undefined)).toThrow(InvalidSessionContextError);
    expect(() => readSessionContext("")).toThrow(InvalidSessionContextError);
  });

  it("JSONでなければ会話を始めない", () => {
    expect(() => readSessionContext("not json")).toThrow(InvalidSessionContextError);
  });

  it("許可トピックが空なら会話を始めない", () => {
    const empty = JSON.stringify({ ...JSON.parse(metadata), allowed_topic_ids: [] });
    expect(() => readSessionContext(empty)).toThrow(/許可トピックが空/);
  });

  it("必須項目が欠けていれば会話を始めない", () => {
    const broken = JSON.stringify({ session_id: "ses_1" });
    expect(() => readSessionContext(broken)).toThrow(InvalidSessionContextError);
  });

  it("将来サーバが項目を足しても壊れない(passthrough)", () => {
    const extended = JSON.stringify({ ...JSON.parse(metadata), future_field: "x" });
    expect(readSessionContext(extended).session_id).toBe("ses_1");
  });
});

describe("remainingSeconds", () => {
  const context = readSessionContext(metadata);
  const startedAt = new Date("2026-08-03T13:00:00.000Z");

  it("経過ぶんを引く", () => {
    expect(remainingSeconds(context, startedAt, new Date("2026-08-03T13:01:00.000Z"))).toBe(240);
  });

  it("超過しても負にならない", () => {
    expect(remainingSeconds(context, startedAt, new Date("2026-08-03T13:10:00.000Z"))).toBe(0);
  });
});
