import { describe, expect, it } from "vitest";
import {
  celebrationHeadline,
  computeProgress,
  computeStreak,
  daysBetween,
  toLocalDate,
} from "./progress.ts";

describe("toLocalDate", () => {
  it("JSTの日付に落とす", () => {
    expect(toLocalDate(new Date("2026-08-03T13:24:07.000Z"))).toBe("2026-08-03");
  });

  it("日付をまたぐ深夜も取り違えない", () => {
    expect(toLocalDate(new Date("2026-08-03T15:30:00.000Z"))).toBe("2026-08-04");
  });
});

describe("daysBetween", () => {
  it("月をまたいでも数えられる", () => {
    expect(daysBetween("2026-07-31", "2026-08-03")).toBe(3);
    expect(daysBetween("2026-08-03", "2026-08-03")).toBe(0);
  });
});

describe("computeStreak", () => {
  it("連続した日を数える", () => {
    expect(computeStreak(["2026-08-01", "2026-08-02", "2026-08-03"], "2026-08-03")).toBe(3);
  });

  // 朝いちばんにホームを開いたユーザーを毎日がっかりさせないための挙動
  it("今日まだやっていなくても、きのうまで続いていれば生きている", () => {
    expect(computeStreak(["2026-08-01", "2026-08-02"], "2026-08-03")).toBe(2);
  });

  it("丸1日空いたら途切れる", () => {
    expect(computeStreak(["2026-08-01"], "2026-08-03")).toBe(0);
  });

  it("同じ日に複数回やっても1日と数える", () => {
    expect(computeStreak(["2026-08-02", "2026-08-02", "2026-08-03"], "2026-08-03")).toBe(2);
  });

  it("途中に穴があれば、そこから後だけ数える", () => {
    expect(
      computeStreak(["2026-07-20", "2026-08-01", "2026-08-02", "2026-08-03"], "2026-08-03"),
    ).toBe(3);
  });

  it("履歴がなければ0", () => {
    expect(computeStreak([], "2026-08-03")).toBe(0);
  });
});

describe("computeProgress", () => {
  it("連続日数・埋めた穴・残りの穴を数える", () => {
    const progress = computeProgress(
      ["2026-08-02", "2026-08-03"],
      [
        { status: "filled", filled_at: "2026-08-03T11:00:00.000Z" },
        { status: "filled", filled_at: "2026-08-02T11:00:00.000Z" },
        { status: "open", filled_at: null },
      ],
      "2026-08-03",
    );
    expect(progress).toEqual({
      streak_days: 2,
      filled_holes: 2,
      open_holes: 1,
      last_session_date: "2026-08-03",
    });
  });

  // 点数・正答率は持たない(数えるのは努力だけ)
  it("スコアに類するフィールドを持たない", () => {
    const progress = computeProgress(["2026-08-03"], [], "2026-08-03");
    expect(Object.keys(progress).sort()).toEqual([
      "filled_holes",
      "last_session_date",
      "open_holes",
      "streak_days",
    ]);
  });
});

describe("celebrationHeadline", () => {
  const base = { streak_days: 1, filled_holes: 0, open_holes: 0, last_session_date: null };

  it("穴が埋まった日はそれを最優先で祝う", () => {
    expect(celebrationHeadline({ ...base, filled_holes: 3 }, 2)).toBe("穴が2つ、埋まりました");
  });

  it("埋まらなくても継続を認める", () => {
    expect(celebrationHeadline({ ...base, streak_days: 4 }, 0)).toBe("4日つづけて説明できています");
  });

  it("初日は説明したこと自体をねぎらう", () => {
    expect(celebrationHeadline(base, 0)).toBe("説明、ありがとうございました");
  });
});
