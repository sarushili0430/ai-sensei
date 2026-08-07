import { describe, expect, it } from "vitest";
import {
  activeStepDays,
  buildReviewPrompt,
  nextReviewStep,
  reviewTimeAfterDays,
  scheduleReviews,
} from "./spaced-repetition.ts";

// 2026-08-03 22:24 JST = 2026-08-03T13:24Z
const completedAt = new Date("2026-08-03T13:24:07.000Z");

describe("scheduleReviews", () => {
  it("穴ごとに翌日・3日後・7日後の3件を作る", () => {
    const entries = scheduleReviews(["hol_1"], completedAt);
    expect(entries.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.scheduled_at)).toEqual([
      "2026-08-04T11:00:00.000Z", // 8/4 20:00 JST
      "2026-08-06T11:00:00.000Z", // 8/6 20:00 JST
      "2026-08-10T11:00:00.000Z", // 8/10 20:00 JST
    ]);
  });

  it("複数の穴をまとめて予約する", () => {
    const entries = scheduleReviews(["hol_1", "hol_2"], completedAt);
    expect(entries).toHaveLength(6);
    expect(new Set(entries.map((entry) => entry.hole_id))).toEqual(new Set(["hol_1", "hol_2"]));
  });

  it("穴がなければ何も予約しない(通知を送らない日がある)", () => {
    expect(scheduleReviews([], completedAt)).toEqual([]);
  });

  it("深夜のセッションでも、ローカル日付を基準に翌日を決める", () => {
    // 8/4 00:30 JST = 8/3 15:30Z。翌日は 8/5 ではなく 8/5 JST。
    const lateNight = new Date("2026-08-03T15:30:00.000Z");
    const [first] = scheduleReviews(["hol_1"], lateNight);
    expect(first?.scheduled_at).toBe("2026-08-05T11:00:00.000Z");
  });

  it("タイムゾーンと時刻を差し替えられる", () => {
    const utcEvening = reviewTimeAfterDays(completedAt, 1, {
      timezoneOffsetMinutes: 0,
      hourLocal: 9,
    });
    expect(utcEvening.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });
});

describe("nextReviewStep", () => {
  it("段階を進め、3段目で打ち切る", () => {
    expect(nextReviewStep(1)).toBe(2);
    expect(nextReviewStep(2)).toBe(3);
    expect(nextReviewStep(3)).toBeNull();
  });
});

describe("activeStepDays", () => {
  // handoff §8: 遅延したら間隔反復を3段階から翌日のみに縮小する
  it("縮小モードでは翌日だけにする", () => {
    expect(activeStepDays()).toEqual([1, 3, 7]);
    expect(activeStepDays(true)).toEqual([1]);
  });
});

describe("buildReviewPrompt", () => {
  it("後輩からのお願いの形で書く", () => {
    expect(
      buildReviewPrompt({ desc: "平方完成を「なぜ」するのか、で説明が止まった", daysSince: 3 }),
    ).toBe("3日前の「平方完成を「なぜ」するのか」、いまなら説明できますか?");
  });

  it("きのう・さっきを言い分ける", () => {
    expect(buildReviewPrompt({ desc: "判別式の意味", daysSince: 1 })).toContain("きのうの");
    expect(buildReviewPrompt({ desc: "判別式の意味", daysSince: 0 })).toContain("さっきの");
  });

  it("長い説明は切り詰める", () => {
    const prompt = buildReviewPrompt({
      desc: "中心と直線の距離を使う方法と連立して判別式を使う方法の使い分け",
      daysSince: 7,
    });
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(50);
  });

  it("責める語彙を含まない", () => {
    const prompt = buildReviewPrompt({ desc: "判別式の意味", daysSince: 7 });
    for (const word of ["サボ", "途切れ", "忘れて", "また", "まだ"]) {
      expect(prompt).not.toContain(word);
    }
  });
});

// 通知の言語は端末の設定ではなく、穴の課程で決まる(呼び出し側が
// topic_id から引く)。取り違えると、日本語で説明した穴が英語で届く。
describe("buildReviewPrompt(英語)", () => {
  it("後輩からのお願いの形にする", () => {
    expect(
      buildReviewPrompt({
        desc: "the explanation stopped at why the discriminant is used",
        daysSince: 1,
        locale: "en",
      }),
    ).toBe('That "why the discriminant is used" from yesterday — could you explain it to me now?');
  });

  it("きのう・さっきを言い分ける", () => {
    const en = (daysSince: number) =>
      buildReviewPrompt({ desc: "why the radius matters", daysSince, locale: "en" });
    expect(en(0)).toContain("from earlier today");
    expect(en(1)).toContain("from yesterday");
    expect(en(3)).toContain("from 3 days ago");
  });

  it("長い説明は切り詰める", () => {
    const prompt = buildReviewPrompt({
      desc: "the explanation stopped at choosing between the distance method and the discriminant method",
      daysSince: 7,
      locale: "en",
    });
    expect(prompt).toContain("…");
  });

  it("責める語彙を含まない", () => {
    const prompt = buildReviewPrompt({
      desc: "why the discriminant is used",
      daysSince: 7,
      locale: "en",
    });
    for (const word of ["forgot", "failed", "again", "still", "should"]) {
      expect(prompt.toLowerCase()).not.toContain(word);
    }
  });
});
