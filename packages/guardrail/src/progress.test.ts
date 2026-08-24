import { describe, expect, it } from "vitest";
import { computeProgress, computeStreak, daysBetween, toLocalDate } from "./progress.ts";

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
  it("連続日数・埋めた穴・残りの穴を数える(旧データ)", () => {
    const progress = computeProgress({
      sessionDates: ["2026-08-02", "2026-08-03"],
      holes: [
        { status: "filled", filled_at: "2026-08-03T11:00:00.000Z" },
        { status: "filled", filled_at: "2026-08-02T11:00:00.000Z" },
        { status: "open", filled_at: null },
      ],
      today: "2026-08-03",
    });
    expect(progress).toEqual({
      streak_days: 2,
      filled_holes: 2,
      open_holes: 1,
      solved_problems: 0,
      open_problems: 0,
      last_session_date: "2026-08-03",
    });
  });

  it("正解した復習問題と、まだ解いていない復習問題を数える", () => {
    const progress = computeProgress({
      sessionDates: ["2026-08-03"],
      problems: [{ id: "prb_1" }, { id: "prb_2" }, { id: "prb_3" }],
      attempts: [
        { problem_id: "prb_1", verdict: "correct" },
        { problem_id: "prb_2", verdict: "incorrect" },
        { problem_id: "prb_3", verdict: "unclear" },
      ],
      today: "2026-08-03",
    });
    // 不正解も `unclear` も、まだ解きにいく側。外れるのは正解した1問だけ。
    expect(progress.solved_problems).toBe(1);
    expect(progress.open_problems).toBe(2);
  });

  // 数えるのは**問題**であって解答回数ではない。回数にすると、
  // 同じ1問を何度も解くほど数字が伸びる。
  it("同じ問題に何度正解しても1問として数える", () => {
    const progress = computeProgress({
      sessionDates: [],
      problems: [{ id: "prb_1" }],
      attempts: [
        { problem_id: "prb_1", verdict: "correct" },
        { problem_id: "prb_1", verdict: "correct" },
      ],
      today: "2026-08-03",
    });
    expect(progress.solved_problems).toBe(1);
    expect(progress.open_problems).toBe(0);
  });

  // ADR 0009 の移行期。穴と復習問題は別々に数え、足し合わせない。
  it("穴と復習問題を混ぜて数えない", () => {
    const progress = computeProgress({
      sessionDates: [],
      holes: [{ status: "filled", filled_at: "2026-08-02T11:00:00.000Z" }],
      problems: [{ id: "prb_1" }],
      attempts: [{ problem_id: "prb_1", verdict: "correct" }],
      today: "2026-08-03",
    });
    expect(progress.filled_holes).toBe(1);
    expect(progress.solved_problems).toBe(1);
  });

  // 点数・正答率は持たない(数えるのは努力だけ)
  it("スコアに類するフィールドを持たない", () => {
    const progress = computeProgress({ sessionDates: ["2026-08-03"], today: "2026-08-03" });
    expect(Object.keys(progress).sort()).toEqual([
      "filled_holes",
      "last_session_date",
      "open_holes",
      "open_problems",
      "solved_problems",
      "streak_days",
    ]);
  });
});
