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
  it("今月の埋めた穴・現在の連続日数・単元名・本人の引用だけを集める", () => {
    const report = computeParentReport({
      today: "2026-08-03",
      sessionDates: ["2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"],
      holes: [
        {
          topic_id: "M1-NIJI-HANBETSU",
          status: "filled",
          filled_at: "2026-08-02T11:00:00.000Z",
        },
        {
          topic_id: "M2-ZUKEI-ENCHOKU",
          status: "filled",
          filled_at: "2026-07-30T11:00:00.000Z",
        },
        { topic_id: "M1-NIJI-GURAFU", status: "open", filled_at: null },
      ],
      kartes: [
        {
          created_at: "2026-08-03T10:00:00.000Z",
          topic_ids: ["M2-ZUKEI-ENCHOKU"],
          said_well: ["中心から直線までの距離と半径を比べる、と説明した"],
        },
        {
          created_at: "2026-07-30T10:00:00.000Z",
          topic_ids: ["M1-NIJI-GURAFU"],
          said_well: ["先月の説明"],
        },
      ],
      limits,
    });

    expect(report).toEqual({
      period: { start_date: "2026-08-01", end_date: "2026-08-03" },
      filled_holes: 1,
      streak_days: 4,
      explained_topics: [
        { topic_id: "M1-NIJI-HANBETSU", name: "二次方程式の判別式と実数解の個数" },
        { topic_id: "M2-ZUKEI-ENCHOKU", name: "円と直線の位置関係" },
      ],
      quotes: ["中心から直線までの距離と半径を比べる、と説明した"],
    });
  });

  it("引用は新しいカルテから、契約の件数までに閉じる", () => {
    const report = computeParentReport({
      today: "2026-08-03",
      sessionDates: [],
      holes: [],
      kartes: [
        {
          created_at: "2026-08-03T10:00:00.000Z",
          topic_ids: ["M1-NIJI-HANBETSU"],
          said_well: ["新しい説明1", "新しい説明2", "同じ説明"],
        },
        {
          created_at: "2026-08-02T10:00:00.000Z",
          topic_ids: ["M1-NIJI-HANBETSU"],
          said_well: ["同じ説明", "古い説明"],
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
      holes: [],
      kartes: [
        {
          created_at: "2026-08-03T10:00:00.000Z",
          topic_ids: ["M1-NIJI-HANBETSU"],
          said_well: ["あ".repeat(201), "契約内の本人の説明"],
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
      holes: [{ topic_id: "M1-UNKNOWN", status: "filled", filled_at: "2026-08-03T10:00:00.000Z" }],
      kartes: [],
      limits,
    });

    expect(report.filled_holes).toBe(1);
    expect(report.explained_topics).toEqual([]);
  });
});
