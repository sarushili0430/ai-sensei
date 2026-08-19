import { describe, expect, it } from "vitest";
import type { UserRecord } from "../repository/types.ts";
import {
  analysesPerDay,
  canReissueToken,
  canStartSessionToday,
  hasPremiumAccess,
  isBetaOpenAccess,
  isPremiumNow,
  limitReachedAllowance,
  secondsPerDay,
  secondsUntilLocalMidnight,
  sessionMaxSeconds,
  shouldShowPaywall,
  startedAllowance,
} from "./entitlement.ts";

const limits = {
  freeSecondsPerDay: 1200,
  premiumSecondsPerDay: 3600,
  freeSessionMaxSeconds: 1200,
  premiumSessionMaxSeconds: 1200,
  betaOpenAccessUntil: null,
  betaSecondsPerDay: 12000,
};
const now = new Date("2026-08-03T13:24:07.000Z"); // 22:24 JST

/** クローズドβの開放中(期限は `now` より後)。 */
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
 * クローズドβの開放。
 *
 * 配れるのが限定公開テストの名簿に載っている人だけ、という前提で
 * **期間中は全員をPremium相当**にする。前提が崩れる日(一般公開)に備えて、
 * 期限を過ぎたら勝手に通常営業へ戻ることをここで固定する。
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

  // β開放は「解放してよいか」の判定であって、支払いの記録ではない。
  // ここが混ざると、webhookの同期やTRANSFERの引き継ぎが嘘の期限を掴む。
  it("β開放中でも、払っていない人は isPremiumNow では false のまま", () => {
    expect(isPremiumNow(user(), now)).toBe(false);
  });
});

describe("β開放中の使い放題", () => {
  it("1日の持ち時間が BETA_SECONDS_PER_DAY まで開く", () => {
    expect(secondsPerDay({ user: user(), now, limits: betaLimits })).toBe(12000);
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
      maxSeconds: 1200,
      remainingSecondsToday: 0,
      sessionsToday: 10,
    });
    expect(allowance.lessonAllowedToday).toBe(false);
  });
});

describe("secondsPerDay / startedAllowance / limitReachedAllowance", () => {
  it("無料と1200秒、Premiumは3600秒を1日の持ち時間にする", () => {
    expect(secondsPerDay({ user: user(), now, limits })).toBe(1200);
    expect(secondsPerDay({ user: user({ is_premium: true }), now, limits })).toBe(3600);
  });

  it("残高が3分未満なら始めず、境界の180秒なら始められる", () => {
    expect(canStartSessionToday({ remainingSecondsToday: 179, sessionsToday: 0 })).toBe(false);
    expect(canStartSessionToday({ remainingSecondsToday: 180, sessionsToday: 0 })).toBe(true);
  });

  it("残高があっても1日20回の開始ガードで止める", () => {
    expect(canStartSessionToday({ remainingSecondsToday: 1200, sessionsToday: 19 })).toBe(true);
    expect(canStartSessionToday({ remainingSecondsToday: 1200, sessionsToday: 20 })).toBe(false);
  });

  it("仮押さえ後の残高が最低単位以上なら、今日もう一度始められる", () => {
    expect(
      startedAllowance({
        maxSeconds: 600,
        remainingSecondsToday: 600,
        sessionsToday: 1,
      }),
    ).toEqual({
      allowed: true,
      maxSeconds: 600,
      remainingSecondsToday: 600,
      lessonAllowedToday: true,
    });
  });

  it("無料ユーザーの持ち時間到達は課金導線側の理由を返す", () => {
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

  it("Premiumの持ち時間到達はフェアユース扱いで翌日まで止める", () => {
    const premiumUser = user({ is_premium: true });
    const allowance = limitReachedAllowance({ user: premiumUser, now, limits });
    expect(allowance).toEqual({
      allowed: false,
      lessonAllowedToday: false,
      retryAfterSeconds: 5753,
      reason: "fair_use_limit_reached",
    });
  });

  it("無料とPremiumで1回の上限時間を変えない", () => {
    expect(sessionMaxSeconds({ user: user(), now, limits })).toBe(1200);
    expect(sessionMaxSeconds({ user: user({ is_premium: true }), now, limits })).toBe(1200);
  });
});

/**
 * 解析の上限は「見せない上限」。日次の持ち時間とは別に持ち、
 * **撮り直しでは絶対に当たらない**ことをここで固定する。
 */
describe("analysesPerDay", () => {
  it("1回の授業あたり、撮り直しに余裕のある回数を許す", () => {
    expect(analysesPerDay({ user: user(), now, limits })).toBe(5);
    expect(analysesPerDay({ user: user({ is_premium: true }), now, limits })).toBe(15);
  });

  it("持ち時間が1回の上限未満に上書きされても、無料の解析5回は減らない", () => {
    const short = { ...limits, freeSecondsPerDay: 600 };
    expect(analysesPerDay({ user: user(), now, limits: short })).toBe(5);
  });
});

/**
 * 押し直しでトークンを出し直せる窓。
 *
 * 無条件に出し直せると、**部屋に入らないまま開いたセッションが、期限のない
 * 鍵の引換券**になる(その時間は最初の日に仮押さえされているので、翌日に押せば
 * 今日の残高を減らさずに授業時間が増える)。
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
    // 20分 + 余白2分 = 22分。その1秒あと。
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

  // 読めない値を「まだ生きている」側へ倒すと、壊れた1行が抜け道になる。
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
