import type { Limits } from "../env.ts";
import type { UserRecord } from "../repository/types.ts";

/**
 * 授業枠の判定。**サーバ側で枠を確保する**(クライアント改竄対策)。
 *
 * Free    : 1日1セッション / Premiumと同じ最長20分 / 当日のカルテ閲覧まで
 * Premium : 通常の1日1〜2回には当たらない非表示のフェアユース上限 / 最長20分
 *
 * **数えるのは「先輩と話した回数」**で、写真を読んだ回数ではない
 * (枠を押さえるのは `POST /v1/sessions/{id}/start`)。撮って単元を確かめただけの
 * 人が、会話を1度もしないまま「今日はここまで」になるのを止めるための線引き。
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

/** その日に始められる本数。無料とPremiumの分岐はここだけ。 */
export function sessionsPerDay(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  return isPremiumNow(input.user, input.now)
    ? input.limits.premiumSessionsPerDay
    : input.limits.freeSessionsPerDay;
}

/**
 * 1回の授業に何度まで写真を読み直してよいか。
 *
 * **回数を数える位置を会話の開始へ移したので、解析はこの上限だけが守っている。**
 * 撮り直し・単元の見直し・気が変わってやめる、を余裕で吸収する数にする一方、
 * 解析だけを延々と繰り返してVision LLMの原価を積む使い方はここで止まる。
 *
 * 環境変数にしていないのは、これがユーザーに見せる約束ではないから。
 * 見せる約束(1日に何回話せるか)は `FREE_SESSIONS_PER_DAY` 側にある。
 * なお読み取れなかった写真は行ごと消えるので、この数に入るのは
 * **解析が通ったぶんだけ**。
 */
export const analysesPerSessionSlot = 5;

/** その日に許す写真解析の本数。授業の枠とは別物(理由は上の定数)。 */
export function analysesPerDay(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  return sessionsPerDay(input) * analysesPerSessionSlot;
}

/** 上限の数値を返さず、いま授業を始められるかだけを共有する。 */
export function canStartSessionToday(input: SessionLimitInput): boolean {
  return input.sessionsToday < sessionsPerDay(input);
}

/** 1回の会話の長さ。**プランで品質は変えない**ので、分岐はこの1か所だけ。 */
export function sessionMaxSeconds(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
}): number {
  return isPremiumNow(input.user, input.now)
    ? input.limits.premiumSessionMaxSeconds
    : input.limits.freeSessionMaxSeconds;
}

/**
 * トークンの寿命に足す余白。
 *
 * 会話の上限ちょうどで切れると、締めの数秒で部屋から蹴り出される。
 * **再送を受け付ける窓もこれと同じ**({@link canReissueToken})。
 */
export const tokenGraceSeconds = 120;

/**
 * 始まっているセッションへ、トークンを出し直してよいか。
 * **最初の鍵がまだ生きているあいだだけ**。
 *
 * `started_at` があれば無条件に出し直せると、**部屋に入らないまま開いた
 * セッションを1本持っておく**道ができる。その1本は最初の日に数えられているので、
 * 翌日に鍵だけ出し直せば、今日の枠を減らさずに授業がもう1回増える
 * (会話が成立しなければ `/complete` も来ないので、行は open のまま残り続ける)。
 *
 * 窓を最初のトークンの寿命に合わせると、再送で救えるのは
 * **同じ会話につなぎ直す場合だけ**になる。それを越えたセッションは、
 * 出し直したところで入る部屋がもう無い。
 */
export function canReissueToken(input: {
  startedAt: string;
  now: Date;
  maxSeconds: number;
}): boolean {
  const elapsedMs = input.now.getTime() - new Date(input.startedAt).getTime();
  // 壊れた `started_at` は NaN になり、この比較は false になる。
  // 読めない値を「まだ生きている」側へ倒さない。
  return elapsedMs <= (input.maxSeconds + tokenGraceSeconds) * 1000;
}

/** 枠を押さえたあとの応答。`sessionsToday` は押さえた分を含む当日の本数。 */
export function startedAllowance(
  input: SessionLimitInput,
): Extract<SessionAllowance, { allowed: true }> {
  return {
    allowed: true,
    maxSeconds: sessionMaxSeconds(input),
    // 旧判定のremaining > 1は、確保後の本数で「上限未満」を見ることと等価。
    lessonAllowedToday: canStartSessionToday(input),
  };
}

/** 押さえられなかったときの応答(理由と「また明日」までの秒数)。 */
export function limitReachedAllowance(input: {
  user: UserRecord | null;
  now: Date;
  limits: Limits;
  timezoneOffsetMinutes?: number;
}): Extract<SessionAllowance, { allowed: false }> {
  const premium = isPremiumNow(input.user, input.now);
  return {
    allowed: false,
    lessonAllowedToday: false,
    retryAfterSeconds: secondsUntilLocalMidnight(input.now, input.timezoneOffsetMinutes ?? 540),
    // Premiumを無料枠として扱うと、モバイルが誤って課金導線へ分岐するため理由を分ける。
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
 * ペイウォールを出す位置。
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
