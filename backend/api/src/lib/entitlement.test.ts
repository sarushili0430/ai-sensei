import { describe, expect, it } from "vitest";
import type { UserRecord } from "../repository/types.ts";
import {
  analysesPerDay,
  canReissueToken,
  hasPremiumAccess,
  isBetaOpenAccess,
  isPremiumNow,
  limitReachedAllowance,
  secondsUntilLocalMidnight,
  sessionMaxSeconds,
  sessionsPerDay,
  shouldShowPaywall,
  startedAllowance,
} from "./entitlement.ts";

const limits = {
  freeSessionsPerDay: 1,
  premiumSessionsPerDay: 3,
  freeSessionMaxSeconds: 1200,
  premiumSessionMaxSeconds: 1200,
  betaOpenAccessUntil: null,
  betaSessionsPerDay: 10,
};
const now = new Date("2026-08-03T13:24:07.000Z"); // 22:24 JST

/** Closed beta open (the deadline is after `now`). */
const betaLimits = { ...limits, betaOpenAccessUntil: new Date("2026-09-30T15:00:00.000Z") };

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

/**
 * Closed beta open access.
 *
 * On the assumption that distribution is limited to the closed testing list,
 * everyone is Premium-equivalent during the period. For the day that assumption
 * breaks (public launch), this pins that it returns to business as usual once the
 * deadline passes.
 */
describe("isBetaOpenAccess / hasPremiumAccess", () => {
  it("期限内なら、課金していない人も機能が開く", () => {
    expect(isBetaOpenAccess({ now, limits: betaLimits })).toBe(true);
    expect(hasPremiumAccess({ user: user(), now, limits: betaLimits })).toBe(true);
  });

  it("期限を過ぎたら通常営業に戻る(外し忘れても勝手に終わる)", () => {
    const expired = { ...limits, betaOpenAccessUntil: new Date("2026-08-01T00:00:00.000Z") };
    expect(isBetaOpenAccess({ now, limits: expired })).toBe(false);
    expect(hasPremiumAccess({ user: user(), now, limits: expired })).toBe(false);
  });

  it("未設定なら何も変わらない", () => {
    expect(isBetaOpenAccess({ now, limits })).toBe(false);
    expect(hasPremiumAccess({ user: user(), now, limits })).toBe(false);
    expect(hasPremiumAccess({ user: user({ is_premium: true }), now, limits })).toBe(true);
  });

  // Beta access decides whether to unlock, not whether payment happened.
  // Conflated, webhook sync and TRANSFER handoff would grab a false expiry.
  it("β開放中でも、払っていない人は isPremiumNow では false のまま", () => {
    expect(isPremiumNow(user(), now)).toBe(false);
  });
});

describe("β開放中の使い放題", () => {
  it("1日の本数が BETA_SESSIONS_PER_DAY まで開く", () => {
    expect(sessionsPerDay({ user: user(), now, limits: betaLimits })).toBe(10);
  });

  it("会話の長さはPremiumと同じ(質はプランで変えない)", () => {
    expect(sessionMaxSeconds({ user: user(), now, limits: betaLimits })).toBe(1200);
  });

  it("上限に当たっても課金導線へ倒さない(無料枠ではなくフェアユース扱い)", () => {
    const allowance = limitReachedAllowance({ user: user(), now, limits: betaLimits });
    expect(allowance.reason).toBe("fair_use_limit_reached");
  });

  it("使い放題でも上限は外さない(従量原価はテスターでも同じだけ動く)", () => {
    const allowance = startedAllowance({
      user: user(),
      sessionsToday: 10,
      now,
      limits: betaLimits,
    });
    expect(allowance.lessonAllowedToday).toBe(false);
  });
});

describe("sessionsPerDay / startedAllowance / limitReachedAllowance", () => {
  it("無料ユーザーの1回目は通る", () => {
    const freeUser = user();
    expect(sessionsPerDay({ user: freeUser, now, limits })).toBe(1);
    const allowance = startedAllowance({ user: freeUser, sessionsToday: 1, now, limits });
    expect(allowance).toEqual({ allowed: true, maxSeconds: 1200, lessonAllowedToday: false });
  });

  it("無料枠を使い切るまでは、今日もう一度授業を受けられる", () => {
    const twoLessonLimits = { ...limits, freeSessionsPerDay: 2 };
    const first = startedAllowance({
      user: user(),
      sessionsToday: 1,
      now,
      limits: twoLessonLimits,
    });
    const second = startedAllowance({
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
    // 22:24:07 JST -> 1h35m53s until midnight
    expect(allowance.retryAfterSeconds).toBe(5753);
  });

  it("Premiumは通常利用の1日1〜2回ではフェアユース上限に当たらない", () => {
    const premiumUser = user({ is_premium: true });
    expect(sessionsPerDay({ user: premiumUser, now, limits })).toBe(3);
    for (const sessionsBeforeReservation of [0, 1, 2]) {
      const allowance = startedAllowance({
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
    const free = startedAllowance({ user: user(), sessionsToday: 1, now, limits });
    const premium = startedAllowance({
      user: user({ is_premium: true }),
      sessionsToday: 1,
      now,
      limits,
    });
    expect(free.maxSeconds).toBe(1200);
    expect(premium).toEqual({ allowed: true, maxSeconds: 1200, lessonAllowedToday: true });
  });
});

/**
 * The analysis cap is a hidden cap. It is held separately from the number of
 * conversations a day (the promise we show), and this pins that retakes never hit it.
 */
describe("analysesPerDay", () => {
  it("1回の授業あたり、撮り直しに余裕のある回数を許す", () => {
    expect(analysesPerDay({ user: user(), now, limits })).toBe(5);
    expect(analysesPerDay({ user: user({ is_premium: true }), now, limits })).toBe(15);
  });

  it("授業の回数より必ず緩い(解析の上限が先に当たると、数える位置を戻したのと同じ)", () => {
    for (const premium of [false, true]) {
      const someone = user({ is_premium: premium });
      expect(analysesPerDay({ user: someone, now, limits })).toBeGreaterThan(
        sessionsPerDay({ user: someone, now, limits }),
      );
    }
  });
});

/**
 * The window for reissuing a token on a retry.
 *
 * Reissuing unconditionally makes a session opened without entering the room a
 * voucher for a key with no expiry (it was counted on day one, so pressing it
 * tomorrow adds a lesson without spending today's slot).
 */
describe("canReissueToken", () => {
  const startedAt = "2026-08-03T13:00:00.000Z";

  it("最初の鍵が生きているあいだは、つなぎ直せる", () => {
    expect(
      canReissueToken({
        startedAt,
        now: new Date("2026-08-03T13:19:00.000Z"),
        maxSeconds: 1200,
      }),
    ).toBe(true);
  });

  it("上限時間 + 余白を過ぎたら、もう出し直さない", () => {
    // 20 min + 2 min grace = 22 min. One second after that.
    expect(
      canReissueToken({
        startedAt,
        now: new Date("2026-08-03T13:22:01.000Z"),
        maxSeconds: 1200,
      }),
    ).toBe(false);
  });

  it("境界(上限時間 + 余白ちょうど)は、まだ生きている扱いにする", () => {
    expect(
      canReissueToken({
        startedAt,
        now: new Date("2026-08-03T13:22:00.000Z"),
        maxSeconds: 1200,
      }),
    ).toBe(true);
  });

  // Falling toward "still alive" on an unreadable value makes one broken row a loophole.
  it("started_at が読めなければ出し直さない", () => {
    expect(canReissueToken({ startedAt: "not-a-date", now, maxSeconds: 1200 })).toBe(false);
  });
});

describe("secondsUntilLocalMidnight", () => {
  it("JSTの日付境界で数える", () => {
    expect(secondsUntilLocalMidnight(new Date("2026-08-03T14:59:00.000Z"), 540)).toBe(60);
  });
});

describe("shouldShowPaywall", () => {
  // Once only, right after holes become visible in the first karte = the moment of felt value
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
