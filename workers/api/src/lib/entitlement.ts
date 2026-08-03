import type { Limits } from "../env.ts";
import type { UserRecord } from "../repository/types.ts";

/**
 * 無料枠の判定。**サーバ側で数える**(クライアント改竄対策・handoff §5)。
 *
 * Free    : 1日1セッション / 会話は最長5分 / 当日のカルテ閲覧まで
 * Premium : セッション無制限 / 穴の復習と履歴 / あと追い質問
 */

export function isPremiumNow(user: UserRecord | null, now: Date): boolean {
  if (!user?.is_premium) return false;
  if (!user.premium_expires_at) return true;
  return new Date(user.premium_expires_at).getTime() > now.getTime();
}

export type SessionAllowance =
  | { allowed: true; maxSeconds: number; remainingToday: number | null }
  | { allowed: false; remainingToday: 0; retryAfterSeconds: number };

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
  if (premium) {
    return {
      allowed: true,
      maxSeconds: input.limits.premiumSessionMaxSeconds,
      remainingToday: null,
    };
  }

  const remaining = input.limits.freeSessionsPerDay - input.sessionsToday;
  if (remaining <= 0) {
    return {
      allowed: false,
      remainingToday: 0,
      retryAfterSeconds: secondsUntilLocalMidnight(input.now, input.timezoneOffsetMinutes ?? 540),
    };
  }

  return {
    allowed: true,
    maxSeconds: input.limits.freeSessionMaxSeconds,
    // このセッションを消費したあとの残数
    remainingToday: remaining - 1,
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
