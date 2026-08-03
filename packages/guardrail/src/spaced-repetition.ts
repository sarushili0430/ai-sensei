/**
 * 間隔反復スケジューラ(翌日 → 3日後 → 7日後)。
 *
 * OneSignal賞の中核であり、後付けの機能ではなく製品そのもの。
 * 通知は「リマインダー」ではなく **後輩からのお願い** として書く。
 * 罪悪感で煽る文面(「記録が途切れます」等)は作らない。
 */

/** 各段の日数。handoff §3-5。 */
export const reviewStepDays = [1, 3, 7] as const;
export type ReviewStep = 1 | 2 | 3;

export type ScheduleOptions = {
  /** ローカルタイムゾーンのUTCオフセット(分)。日本の高校生向けなので既定はJST。 */
  timezoneOffsetMinutes?: number;
  /** 通知するローカル時刻。夜の勉強時間帯に置く。 */
  hourLocal?: number;
  minuteLocal?: number;
};

const DEFAULTS = { timezoneOffsetMinutes: 540, hourLocal: 20, minuteLocal: 0 } as const;

export type ScheduledReview = {
  hole_id: string;
  step: ReviewStep;
  scheduled_at: string;
};

/**
 * セッション完了時に、その日できた穴の再説明を3段階で予約する。
 * 予約はサーバ側で作り、OneSignalのスケジュール送信に載せる(cronは持たない)。
 */
export function scheduleReviews(
  holeIds: readonly string[],
  completedAt: Date,
  options: ScheduleOptions = {},
): ScheduledReview[] {
  const entries: ScheduledReview[] = [];
  for (const holeId of holeIds) {
    reviewStepDays.forEach((days, index) => {
      entries.push({
        hole_id: holeId,
        step: (index + 1) as ReviewStep,
        scheduled_at: reviewTimeAfterDays(completedAt, days, options).toISOString(),
      });
    });
  }
  return entries;
}

/** completedAt のローカル日付から days 日後の、指定ローカル時刻のUTC時刻。 */
export function reviewTimeAfterDays(
  completedAt: Date,
  days: number,
  options: ScheduleOptions = {},
): Date {
  const offsetMinutes = options.timezoneOffsetMinutes ?? DEFAULTS.timezoneOffsetMinutes;
  const hour = options.hourLocal ?? DEFAULTS.hourLocal;
  const minute = options.minuteLocal ?? DEFAULTS.minuteLocal;

  const local = new Date(completedAt.getTime() + offsetMinutes * 60_000);
  const localTargetMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + days,
    hour,
    minute,
  );
  return new Date(localTargetMs - offsetMinutes * 60_000);
}

/** 再説明で埋まらなかったときに次の段へ進める。3段目まで行ったら打ち切る。 */
export function nextReviewStep(current: ReviewStep): ReviewStep | null {
  return current < 3 ? ((current + 1) as ReviewStep) : null;
}

/**
 * 遅延したときに落とす順(handoff §8のソロ運用ルール)。
 * 3段階 → 翌日のみ、に縮小するためのフラグ。
 */
export function activeStepDays(reduced = false): readonly number[] {
  return reduced ? [reviewStepDays[0]] : reviewStepDays;
}

export type ReviewPromptInput = {
  /** 穴の説明。「判別式を『なぜ』使うのか、で説明が止まった」 */
  desc: string;
  /** 何日前にできた穴か。 */
  daysSince: number;
};

/**
 * 通知文とレビュー画面の一行を作る。
 * 後輩の声・敬語・お願いの形。責める語彙と記録を人質に取る表現は使わない。
 */
export function buildReviewPrompt({ desc, daysSince }: ReviewPromptInput): string {
  const when = daysSince <= 0 ? "さっき" : daysSince === 1 ? "きのう" : `${daysSince}日前`;
  const subject = toSubject(desc);
  return `${when}の「${subject}」、いまなら説明できますか?`;
}

/** 穴の説明文から、通知に載る短い主題を取り出す。 */
function toSubject(desc: string): string {
  const trimmed = desc
    .replace(/[、,]?\s*で説明が止まった。?$/u, "")
    .replace(/[、,]?\s*説明できなかった。?$/u, "")
    .replace(/^「|」$/gu, "")
    .trim();
  const subject = trimmed.length > 0 ? trimmed : desc.trim();
  return subject.length <= 24 ? subject : `${subject.slice(0, 23)}…`;
}
