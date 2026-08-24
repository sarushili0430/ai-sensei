import { describe, expect, it } from "vitest";
import { computeParentReport, currentMonthPeriod } from "./parent-report.ts";

const limits = { quoteCount: 3, quoteLength: 200, topicCount: 12 };

describe("currentMonthPeriod", () => {
  it("月初から作成日までを今月として返す", () => {
    expect(currentMonthPeriod("2026-08-11")).toEqual({
      start_date: "2026-08-01",
      end_date: "2026-08-11",
    });
  });
});

describe("computeParentReport", () => {
  it("今月解けた問題・現在の連続日数・単元名・正解した本人の言葉だけを集める", () => {
    const report = computeParentReport({
      today: "2026-08-03",
      sessionDates: ["2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"],
      // 同じ移行期に穴と問題が残っても、成果を足して水増ししない。
      holes: [
        {
          topic_id: "M1-NIJI-HANBETSU",
          status: "filled",
          filled_at: "2026-08-02T11:00:00.000Z",
        },
      ],
      problems: [
        { id: "prb_discriminant", topic_id: "M1-NIJI-HANBETSU" },
        { id: "prb_circle", topic_id: "M2-ZUKEI-ENCHOKU" },
      ],
      attempts: [
        {
          problem_id: "prb_circle",
          verdict: "correct",
          answered_at: "2026-08-02T11:00:00.000Z",
          response: "中心から直線までの距離と半径を比べます",
        },
        {
          problem_id: "prb_discriminant",
          verdict: "correct",
          answered_at: "2026-08-03T10:00:00.000Z",
          response: "判別式の符号で実数解の個数が決まります",
        },
        {
          problem_id: "prb_discriminant",
          verdict: "incorrect",
          answered_at: "2026-08-03T10:01:00.000Z",
          response: "採点で不正解だった答えは親へ見せない",
        },
      ],
      limits,
    });

    expect(report).toEqual({
      period: { start_date: "2026-08-01", end_date: "2026-08-03" },
      // 穴1件 + 問題2件の3ではなく、正になった問題側の2件だけ。
      filled_holes: 2,
      streak_days: 4,
      explained_topics: [
        { topic_id: "M1-NIJI-HANBETSU", name: "二次方程式の判別式と実数解の個数" },
        { topic_id: "M2-ZUKEI-ENCHOKU", name: "円と直線の位置関係" },
      ],
      quotes: ["判別式の符号で実数解の個数が決まります", "中心から直線までの距離と半径を比べます"],
    });
  });

  it("引用は新しい正解から、契約の件数までに閉じる", () => {
    const report = computeParentReport({
      today: "2026-08-03",
      sessionDates: [],
      problems: [{ id: "prb_1", topic_id: "M1-NIJI-HANBETSU" }],
      attempts: [
        {
          problem_id: "prb_1",
          verdict: "correct",
          answered_at: "2026-08-03T10:01:00.000Z",
          response: "古い説明",
        },
        {
          problem_id: "prb_1",
          verdict: "correct",
          answered_at: "2026-08-03T10:02:00.000Z",
          response: "同じ説明",
        },
        {
          problem_id: "prb_1",
          verdict: "correct",
          answered_at: "2026-08-03T10:03:00.000Z",
          response: "同じ説明",
        },
        {
          problem_id: "prb_1",
          verdict: "correct",
          answered_at: "2026-08-03T10:04:00.000Z",
          response: "新しい説明2",
        },
        {
          problem_id: "prb_1",
          verdict: "correct",
          answered_at: "2026-08-03T10:05:00.000Z",
          response: "新しい説明1",
        },
      ],
      limits,
    });

    expect(report.quotes).toEqual(["新しい説明1", "新しい説明2", "同じ説明"]);
  });

  it("長すぎる古い引用を切り貼りせず、引用から外す", () => {
    const report = computeParentReport({
      today: "2026-08-03",
      sessionDates: [],
      problems: [{ id: "prb_1", topic_id: "M1-NIJI-HANBETSU" }],
      attempts: [
        {
          problem_id: "prb_1",
          verdict: "correct",
          answered_at: "2026-08-03T10:00:00.000Z",
          response: "契約内の本人の説明",
        },
        {
          problem_id: "prb_1",
          verdict: "correct",
          answered_at: "2026-08-03T10:01:00.000Z",
          response: "あ".repeat(201),
        },
      ],
      limits,
    });

    expect(report.quotes).toEqual(["契約内の本人の説明"]);
  });

  it("未知のtopic_idを内部記号のまま親へ見せない", () => {
    const report = computeParentReport({
      today: "2026-08-03",
      sessionDates: [],
      problems: [{ id: "prb_unknown", topic_id: "M1-UNKNOWN" }],
      attempts: [
        {
          problem_id: "prb_unknown",
          verdict: "correct",
          answered_at: "2026-08-03T10:00:00.000Z",
          response: "本人の正しい説明",
        },
      ],
      limits,
    });

    expect(report.filled_holes).toBe(1);
    expect(report.explained_topics).toEqual([]);
  });

  /** 正解が一つもない月にも親レポート自体は必要で、空の引用を失敗扱いにしない。 */
  it("引用が0件でも空配列のレポートを返す", () => {
    const report = computeParentReport({
      today: "2026-08-03",
      sessionDates: ["2026-08-03"],
      problems: [{ id: "prb_1", topic_id: "M1-NIJI-HANBETSU" }],
      attempts: [
        {
          problem_id: "prb_1",
          verdict: "unclear",
          answered_at: "2026-08-03T10:00:00.000Z",
          response: "採点できなかった答え",
        },
      ],
      limits,
    });

    expect(report.quotes).toEqual([]);
    expect(report.filled_holes).toBe(0);
    expect(report.streak_days).toBe(1);
  });
});
