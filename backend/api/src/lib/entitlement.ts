import type { Limits } from "../env.ts";
import type { UserRecord } from "../repository/types.ts";

/**
 * 授業枠の判定。**サーバ側で数える**(クライアント改竄対策・handoff §5)。
 *
 * Free    : 1日1セッション / Premiumと同じ最長20分 / 当日のカルテ閲覧まで
 * Premium : 通常の1日1〜2回には当たらない非表示のフェアユース上限 / 最長20分
 */

export function isPremiumNow(user: UserRecord | null, now: Date): boolean {
  if (!user?.is_premium) return false;
  if (!user.premium_expires_at) return true;
  return new Date(user.premium_expires_at).getTime() > now.getTime();
}

export type SessionAllowance =
  | { allowed: true; maxSeconds: number; lessonAllowedToday: boolean }
  | {
      allowed: false;
      lessonAllowedToday: false;
      retryAfterSeconds: number;
      reason: "free_limit_reached" | "fair_use_limit_reached";
    };

type SessionLimitInput = {
  user: UserRecord | null;
  sessionsToday: number;
  now: Date;
  limits: Limits;
};

/** 上限の数値を返さず、いま授業を始められるかだけを共有する。 */
export function canStartSessionToday(input: SessionLimitInput): boolean {
  const premium = isPremiumNow(input.user, input.now);
  const sessionsPerDay = premium
    ? input.limits.premiumSessionsPerDay
    : input.limits.freeSessionsPerDay;
  return input.sessionsToday < sessionsPerDay;
}

/**
 * そのデバイスが今セッションを始められるかを判定する。
 * 制限に当たった場合、翌日の0時(ローカル)までの秒数を返して
 * 「また明日」と言えるようにする。
 */
export function checkSessionAllowance(input: {
  user: UserRecord | null;
  sessionsToday: number;
  now: Date;
  limits: Limits;
  timezoneOffsetMinutes?: number;
}): SessionAllowance {
  const premium = isPremiumNow(input.user, input.now);
  const sessionsPerDay = premium
    ? input.limits.premiumSessionsPerDay
    : input.limits.freeSessionsPerDay;
  const remaining = sessionsPerDay - input.sessionsToday;
  if (remaining <= 0) {
    return {
      allowed: false,
      lessonAllowedToday: false,
      retryAfterSeconds: secondsUntilLocalMidnight(input.now, input.timezoneOffsetMinutes ?? 540),
      // Premiumを無料枠として扱うと、モバイルが誤って課金導線へ分岐するため理由を分ける。
      reason: premium ? "fair_use_limit_reached" : "free_limit_reached",
    };
  }

  return {
    allowed: true,
    maxSeconds: premium
      ? input.limits.premiumSessionMaxSeconds
      : input.limits.freeSessionMaxSeconds,
    // 成功したセッションは直後に予約される。§6-3の方針どおり、残数ではなく次の授業の可否だけを渡す。
    lessonAllowedToday: remaining > 1,
  };
}

export function secondsUntilLocalMidnight(now: Date, timezoneOffsetMinutes: number): number {
  const local = new Date(now.getTime() + timezoneOffsetMinutes * 60_000);
  const nextMidnightLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
  );
  return Math.max(0, Math.ceil((nextMidnightLocal - local.getTime()) / 1000));
}

/**
 * ペイウォールを出す位置(handoff §6)。
 * 初回カルテで穴が見えた直後 = 価値実感の瞬間、の1回だけ。
 * 煽らないので、2回目以降は出さない。
 */
export function shouldShowPaywall(input: {
  isPremium: boolean;
  completedSessionCount: number;
  holesFound: number;
}): boolean {
  if (input.isPremium) return false;
  return input.completedSessionCount === 1 && input.holesFound > 0;
}
