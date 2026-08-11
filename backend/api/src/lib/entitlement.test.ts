import { describe, expect, it } from "vitest";
import type { UserRecord } from "../repository/types.ts";
import {
  isPremiumNow,
  limitReachedAllowance,
  reservedAllowance,
  secondsUntilLocalMidnight,
  sessionsPerDay,
  shouldShowPaywall,
} from "./entitlement.ts";

const limits = {
  freeSessionsPerDay: 1,
  premiumSessionsPerDay: 3,
  freeSessionMaxSeconds: 1200,
  premiumSessionMaxSeconds: 1200,
};
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

describe("sessionsPerDay / reservedAllowance / limitReachedAllowance", () => {
  it("無料ユーザーの1回目は通る", () => {
    const freeUser = user();
    expect(sessionsPerDay({ user: freeUser, now, limits })).toBe(1);
    const allowance = reservedAllowance({ user: freeUser, sessionsToday: 1, now, limits });
    expect(allowance).toEqual({ allowed: true, maxSeconds: 1200, lessonAllowedToday: false });
  });

  it("無料枠を使い切るまでは、今日もう一度授業を受けられる", () => {
    const twoLessonLimits = { ...limits, freeSessionsPerDay: 2 };
    const first = reservedAllowance({
      user: user(),
      sessionsToday: 1,
      now,
      limits: twoLessonLimits,
    });
    const second = reservedAllowance({
      user: user(),
      sessionsToday: 2,
      now,
      limits: twoLessonLimits,
    });

    expect(first.lessonAllowedToday).toBe(true);
    expect(second.lessonAllowedToday).toBe(false);
  });

  it("無料ユーザーの2回目は止める", () => {
    expect(sessionsPerDay({ user: user(), now, limits })).toBe(1);
    const allowance = limitReachedAllowance({ user: user(), now, limits });
    expect(allowance).toMatchObject({
      allowed: false,
      lessonAllowedToday: false,
      reason: "free_limit_reached",
    });
  });

  it("止めるときは翌日までの秒数を返す(「また明日」と言えるように)", () => {
    const allowance = limitReachedAllowance({ user: user(), now, limits });
    // 22:24:07 JST → 翌0:00まで 1時間35分53秒
    expect(allowance.retryAfterSeconds).toBe(5753);
  });

  it("Premiumは通常利用の1日1〜2回ではフェアユース上限に当たらない", () => {
    const premiumUser = user({ is_premium: true });
    expect(sessionsPerDay({ user: premiumUser, now, limits })).toBe(3);
    for (const sessionsBeforeReservation of [0, 1, 2]) {
      const allowance = reservedAllowance({
        user: premiumUser,
        sessionsToday: sessionsBeforeReservation + 1,
        now,
        limits,
      });
      expect(allowance.allowed).toBe(true);
    }
  });

  it("Premiumは3回を使ったあとの4回目を翌日まで止める", () => {
    const premiumUser = user({ is_premium: true });
    expect(sessionsPerDay({ user: premiumUser, now, limits })).toBe(3);
    const allowance = limitReachedAllowance({ user: premiumUser, now, limits });
    expect(allowance).toEqual({
      allowed: false,
      lessonAllowedToday: false,
      retryAfterSeconds: 5753,
      reason: "fair_use_limit_reached",
    });
  });

  it("無料とPremiumで1回の上限時間を変えない", () => {
    const free = reservedAllowance({ user: user(), sessionsToday: 1, now, limits });
    const premium = reservedAllowance({
      user: user({ is_premium: true }),
      sessionsToday: 1,
      now,
      limits,
    });
    expect(free.maxSeconds).toBe(1200);
    expect(premium).toEqual({ allowed: true, maxSeconds: 1200, lessonAllowedToday: true });
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
