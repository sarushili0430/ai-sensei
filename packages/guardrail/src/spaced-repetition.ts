import type { CurriculumLocale } from "@ai-sensei/curriculum";

/**
 * The spaced-repetition scheduler (+1 day -> +3 days -> +7 days).
 *
 * The core of the OneSignal award and the product itself, not a bolt-on.
 * Notifications are written as a request from the agent, never as a "reminder".
 * Guilt-based wording ("your record is about to break") is never written.
 */

/** The days at each step. */
export const reviewStepDays = [1, 3, 7] as const;
export type ReviewStep = 1 | 2 | 3;

export type ScheduleOptions = {
  /** The local timezone's UTC offset in minutes. Aimed at Japanese high-schoolers, so it defaults to JST. */
  timezoneOffsetMinutes?: number;
  /** The local hour to notify at. Placed in the evening study window. */
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
 * On session completion, books three re-explanations of that day's holes.
 * The bookings are made server-side and ride OneSignal's scheduled send (there is
 * no cron).
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

/** The UTC time at the given local hour, `days` days after completedAt's local date. */
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

/** Advances to the next step when re-explaining did not fill it. Stops after step 3. */
export function nextReviewStep(current: ReviewStep): ReviewStep | null {
  return current < 3 ? ((current + 1) as ReviewStep) : null;
}

/**
 * The order to drop things when running late (the solo-operation rule).
 * A flag for shrinking three steps down to the next day only.
 */
export function activeStepDays(reduced = false): readonly number[] {
  return reduced ? [reviewStepDays[0]] : reviewStepDays;
}

export type ReviewPromptInput = {
  /** The hole's description: "the explanation stalled at *why* the discriminant is used". */
  desc: string;
  /** How many days ago the hole appeared. */
  daysSince: number;
  /**
   * The wording's language. Defaults to Japanese.
   *
   * The caller derives it from the hole's topic_id (`localeOfTopicId`). A hole's
   * description is written in that curriculum's language, so getting it wrong
   * produces a notification like "yesterday's 'why the discriminant is used'".
   */
  locale?: CurriculumLocale;
};

/**
 * Builds the notification text and the review screen's one-liner.
 * The agent's voice, in the form of a request. No blaming vocabulary and nothing
 * that holds a record hostage.
 */
export function buildReviewPrompt({ desc, daysSince, locale = "ja" }: ReviewPromptInput): string {
  if (locale === "en") {
    const when =
      daysSince <= 0 ? "earlier today" : daysSince === 1 ? "yesterday" : `${daysSince} days ago`;
    return `That "${toSubject(desc, locale)}" from ${when} — could you explain it to me now?`;
  }
  const when = daysSince <= 0 ? "さっき" : daysSince === 1 ? "きのう" : `${daysSince}日前`;
  return `${when}の「${toSubject(desc, locale)}」、いまなら説明できますか?`;
}

/** Extracts the short subject that goes into the notification, from the hole's description. */
function toSubject(desc: string, locale: CurriculumLocale): string {
  const trimmed =
    locale === "en"
      ? desc
          .replace(/^the explanation stopped at\s+/iu, "")
          .replace(/^(?:you )?stopped at\s+/iu, "")
          .replace(/[,]?\s*(?:—|-)?\s*(?:where )?the explanation stopped\.?$/iu, "")
          .replace(/^["“]|["”]$/gu, "")
          .trim()
      : desc
          .replace(/[、,]?\s*で説明が止まった。?$/u, "")
          .replace(/[、,]?\s*説明できなかった。?$/u, "")
          .replace(/^「|」$/gu, "")
          .trim();

  const subject = trimmed.length > 0 ? trimmed : desc.trim();
  // English carries less information per character, so take more of it to fill the same apparent length.
  const limit = locale === "en" ? 48 : 24;
  return subject.length <= limit ? subject : `${subject.slice(0, limit - 1)}…`;
}
