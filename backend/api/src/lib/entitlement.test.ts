import { describe, expect, it } from "vitest";
import type { UserRecord } from "../repository/types.ts";
import {
  checkSessionAllowance,
  isPremiumNow,
  secondsUntilLocalMidnight,
  shouldShowPaywall,
} from "./entitlement.ts";

const limits = { freeSessionsPerDay: 1, freeSessionMaxSeconds: 300, premiumSessionMaxSeconds: 900 };
const now = new Date("2026-08-03T13:24:07.000Z"); // 22:24 JST

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    device_id: "d",
    created_at: "2026-08-01T00:00:00.000Z",
    is_premium: false,
    premium_expires_at: null,
    rc_app_user_id: null,
    ...overrides,
  };
}

describe("isPremiumNow", () => {
  it("期限なしのPremiumは有効", () => {
    expect(isPremiumNow(user({ is_premium: true }), now)).toBe(true);
  });

  it("期限内なら有効", () => {
    expect(
      isPremiumNow(user({ is_premium: true, premium_expires_at: "2026-09-01T00:00:00.000Z" }), now),
    ).toBe(true);
  });

  it("期限切れは無効", () => {
    expect(
      isPremiumNow(user({ is_premium: true, premium_expires_at: "2026-08-01T00:00:00.000Z" }), now),
    ).toBe(false);
  });

  it("ユーザーが未登録なら無効", () => {
    expect(isPremiumNow(null, now)).toBe(false);
  });
});

describe("checkSessionAllowance", () => {
  it("無料ユーザーの1回目は通る", () => {
    const allowance = checkSessionAllowance({ user: user(), sessionsToday: 0, now, limits });
    expect(allowance).toEqual({ allowed: true, maxSeconds: 300, lessonAllowedToday: false });
  });

  it("無料枠を使い切るまでは、今日もう一度授業を受けられる", () => {
    const twoLessonLimits = { ...limits, freeSessionsPerDay: 2 };
    const first = checkSessionAllowance({
      user: user(),
      sessionsToday: 0,
      now,
      limits: twoLessonLimits,
    });
    const second = checkSessionAllowance({
      user: user(),
      sessionsToday: 1,
      now,
      limits: twoLessonLimits,
    });

    expect(first.lessonAllowedToday).toBe(true);
    expect(second.lessonAllowedToday).toBe(false);
  });

  it("無料ユーザーの2回目は止める", () => {
    const allowance = checkSessionAllowance({ user: user(), sessionsToday: 1, now, limits });
    expect(allowance.allowed).toBe(false);
    expect(allowance.lessonAllowedToday).toBe(false);
  });

  it("止めるときは翌日までの秒数を返す(「また明日」と言えるように)", () => {
    const allowance = checkSessionAllowance({ user: user(), sessionsToday: 1, now, limits });
    if (allowance.allowed) throw new Error("止まっていない");
    // 22:24:07 JST → 翌0:00まで 1時間35分53秒
    expect(allowance.retryAfterSeconds).toBe(5753);
  });

  it("Premiumは何回でも通り、上限秒数が長い", () => {
    const allowance = checkSessionAllowance({
      user: user({ is_premium: true }),
      sessionsToday: 5,
      now,
      limits,
    });
    expect(allowance).toEqual({ allowed: true, maxSeconds: 900, lessonAllowedToday: true });
  });
});

describe("secondsUntilLocalMidnight", () => {
  it("JSTの日付境界で数える", () => {
    expect(secondsUntilLocalMidnight(new Date("2026-08-03T14:59:00.000Z"), 540)).toBe(60);
  });
});

describe("shouldShowPaywall", () => {
  // 初回カルテで穴が見えた直後 = 価値実感の瞬間、の1回だけ
  it("初回カルテで穴があれば出す", () => {
    expect(shouldShowPaywall({ isPremium: false, completedSessionCount: 1, holesFound: 1 })).toBe(
      true,
    );
  });

  it("2回目以降は出さない(煽らない)", () => {
    expect(shouldShowPaywall({ isPremium: false, completedSessionCount: 2, holesFound: 3 })).toBe(
      false,
    );
  });

  it("穴が見つからなければ出さない(価値を実感していない)", () => {
    expect(shouldShowPaywall({ isPremium: false, completedSessionCount: 1, holesFound: 0 })).toBe(
      false,
    );
  });

  it("Premiumには出さない", () => {
    expect(shouldShowPaywall({ isPremium: true, completedSessionCount: 1, holesFound: 2 })).toBe(
      false,
    );
  });
});
