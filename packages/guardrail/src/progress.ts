/**
 * Count only effort (the visual policy).
 *
 * No right/wrong, scores or XP - only streak days and filled holes are counted.
 * The celebration screen and the home counters are built from those two.
 */

export type LocalDate = string; // YYYY-MM-DD

const JST_OFFSET_MINUTES = 540;

/** Maps a UTC instant to the user's local date (JST by default). */
export function toLocalDate(at: Date, timezoneOffsetMinutes = JST_OFFSET_MINUTES): LocalDate {
  const local = new Date(at.getTime() + timezoneOffsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const month = `${local.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${local.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toUtcDays(date: LocalDate): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) / 86_400_000);
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toUtcDays(to) - toUtcDays(from);
}

/**
 * The streak.
 *
 * Showing it as broken merely because "today is not done yet" would disappoint
 * every user who opens home first thing in the morning. A streak is alive if it ran
 * through yesterday, and it breaks only after a full day's gap.
 */
export function computeStreak(sessionDates: readonly LocalDate[], today: LocalDate): number {
  const unique = [...new Set(sessionDates)].sort();
  if (unique.length === 0) return 0;

  const latest = unique[unique.length - 1];
  if (latest === undefined) return 0;

  const gapFromToday = daysBetween(latest, today);
  if (gapFromToday > 1) return 0; // 丸1日以上空いた

  let streak = 1;
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const current = unique[index];
    const previous = unique[index - 1];
    if (current === undefined || previous === undefined) break;
    if (daysBetween(previous, current) !== 1) break;
    streak += 1;
  }
  return streak;
}

export type HoleLike = {
  status: "open" | "filled";
  filled_at?: string | null;
};

export type ProgressCounters = {
  streak_days: number;
  filled_holes: number;
  open_holes: number;
  last_session_date: LocalDate | null;
};

export function computeProgress(
  sessionDates: readonly LocalDate[],
  holes: readonly HoleLike[],
  today: LocalDate,
): ProgressCounters {
  const sorted = [...new Set(sessionDates)].sort();
  return {
    streak_days: computeStreak(sorted, today),
    filled_holes: holes.filter((hole) => hole.status === "filled").length,
    open_holes: holes.filter((hole) => hole.status === "open").length,
    last_session_date: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * The one line shown on the celebration screen.
 * The only numbers are streak days and filled holes. Praise is aimed at the
 * explanation itself.
 */
export function celebrationHeadline(counters: ProgressCounters, filledThisSession: number): string {
  if (filledThisSession > 0) {
    return `穴が${filledThisSession}つ、埋まりました`;
  }
  if (counters.streak_days >= 2) {
    return `${counters.streak_days}日つづけて説明できています`;
  }
  return "説明、ありがとうございました";
}
