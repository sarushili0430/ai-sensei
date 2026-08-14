import type { Limits } from "../env.ts";
import type { UserRecord } from "../repository/types.ts";

/**
 * Lesson-slot decisions. The slot is claimed server-side (against client tampering).
 *
 * Free    : 1 session/day / same 20-minute max as Premium / same-day karte viewing
 * Premium : a hidden fair-use cap that 1-2 lessons a day never hits / 20-minute max
 * Beta    : everyone is Premium-equivalent during the period. Only the count is
 *           loosened via `BETA_SESSIONS_PER_DAY` ({@link isBetaOpenAccess})
 *
 * What is counted is conversations with the senpai, not photos read (the slot is
 * claimed by `POST /v1/sessions/{id}/start`). The line exists so that someone who
 * only took a photo and confirmed the unit is not told "that's it for today"
 * without ever having a conversation.
 */

export function isPremiumNow(user: UserRecord | null, now: Date): boolean {
  if (!user?.is_premium) return false;
  if (!user.premium_expires_at) return true;
  return new Date(user.premium_expires_at).getTime() > now.getTime();
}

/**
 * Whether the closed beta is open (`BETA_OPEN_ACCESS_UNTIL`).
 *
 * During this period only people on the limited-release tester list can install
 * the app, so "everyone" and "testers" are the same set. That removes any need
 * to collect device ids and grant them one by one, and a new device after an
 * upgrade needs no re-granting.
 *
 * Public release breaks that assumption. It expires automatically because a flag
 * left on is only ever discovered as "somehow nobody sees the paywall".
 */
export function isBetaOpenAccess(input: { now: Date; limits: Limits }): boolean {
  const until = input.limits.betaOpenAccessUntil;
  return until !== null && input.now.getTime() < until.getTime();
}

/**
 * Whether to unlock features. Every entitlement check goes through here.
 *
 * Review voice lessons, study plans, parent reports, follow-up questions and
 * paywall gating all converge here. Beta access sits one layer above
 * `isPremiumNow` rather than inside it, because `isPremiumNow` must keep
 * answering "did they actually pay" (webhook sync and TRANSFER handoff read that).
 */
export function hasPremiumAccess(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): boolean {
  return isBetaOpenAccess(input) || isPremiumNow(input.user, input.now);
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

/** How many can be started that day. The free/Premium branch lives only here. */
export function sessionsPerDay(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  // Beta feels unlimited, but the cap itself stays. LiveKit, STT, LLM and TTS
  // metered costs run the same for testers.
  if (isBetaOpenAccess(input)) return input.limits.betaSessionsPerDay;
  return isPremiumNow(input.user, input.now)
    ? input.limits.premiumSessionsPerDay
    : input.limits.freeSessionsPerDay;
}

/**
 * How many times a photo may be re-read within one lesson.
 *
 * Since counting moved to conversation start, this cap is all that guards
 * analysis. Set high enough to absorb retakes, unit reconsideration and changes
 * of mind, while stopping endless analysis that racks up Vision LLM cost.
 *
 * It is not an env var because it is not a promise shown to users. The promise
 * that is shown (how many conversations a day) lives in `FREE_SESSIONS_PER_DAY`.
 * Unreadable photos delete the row, so only successful analyses count here.
 */
export const analysesPerSessionSlot = 5;

/** How many photo analyses to allow that day. Distinct from the lesson slot (see the constant above). */
export function analysesPerDay(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  return sessionsPerDay(input) * analysesPerSessionSlot;
}

/** Shares only whether a lesson can start now, never the cap's number. */
export function canStartSessionToday(input: SessionLimitInput): boolean {
  return input.sessionsToday < sessionsPerDay(input);
}

/** Length of one conversation. Quality never varies by plan, so this is the only branch. */
export function sessionMaxSeconds(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  return hasPremiumAccess(input)
    ? input.limits.premiumSessionMaxSeconds
    : input.limits.freeSessionMaxSeconds;
}

/**
 * Slack added to the token's lifetime.
 *
 * Expiring exactly at the conversation cap kicks the user out during the closing
 * seconds. The reissue window is the same ({@link canReissueToken}).
 */
export const tokenGraceSeconds = 120;

/**
 * Whether a token may be reissued for a started session.
 * Only while the first key is still alive.
 *
 * Reissuing unconditionally whenever `started_at` exists creates a way to keep
 * one session open without ever entering the room. That session was counted on
 * day one, so reissuing only the key tomorrow adds a lesson without spending
 * today's slot (without a conversation `/complete` never arrives, so the row
 * stays open forever).
 *
 * Matching the window to the first token's lifetime means a reissue can only
 * rescue a reconnect to the same conversation. Past that, there is no room left
 * to enter anyway.
 */
export function canReissueToken(input: {
  startedAt: string;
  now: Date;
  maxSeconds: number;
}): boolean {
  const elapsedMs = input.now.getTime() - new Date(input.startedAt).getTime();
  // A broken `started_at` becomes NaN and this comparison is false.
  // An unreadable value must not fall toward "still alive".
  return elapsedMs <= (input.maxSeconds + tokenGraceSeconds) * 1000;
}

/** The response after claiming a slot. `sessionsToday` includes the one just claimed. */
export function startedAllowance(
  input: SessionLimitInput,
): Extract<SessionAllowance, { allowed: true }> {
  return {
    allowed: true,
    maxSeconds: sessionMaxSeconds(input),
    // The old remaining > 1 check is equivalent to testing "below the cap" post-claim.
    lessonAllowedToday: canStartSessionToday(input),
  };
}

/** The response when it could not be claimed (reason, and seconds until tomorrow). */
export function limitReachedAllowance(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
  timezoneOffsetMinutes?: number;
}): Extract<SessionAllowance, { allowed: false }> {
  // Beta testers count as unlocked here too. Returning free-tier would show the
  // purchase screen to people we told they need not pay.
  const premium = hasPremiumAccess(input);
  return {
    allowed: false,
    lessonAllowedToday: false,
    retryAfterSeconds: secondsUntilLocalMidnight(input.now, input.timezoneOffsetMinutes ?? 540),
    // Treating Premium as free-tier makes mobile branch into the purchase flow, so the reasons differ.
    reason: premium ? "fair_use_limit_reached" : "free_limit_reached",
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
 * Where the paywall appears.
 * Once only, right after holes become visible in the first karte = the moment of
 * felt value. We do not nag, so it never shows again.
 */
export function shouldShowPaywall(input: {
  isPremium: boolean;
  completedSessionCount: number;
  holesFound: number;
}): boolean {
  if (input.isPremium) return false;
  return input.completedSessionCount === 1 && input.holesFound > 0;
}
