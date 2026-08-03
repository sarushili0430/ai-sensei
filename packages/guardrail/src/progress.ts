/**
 * 数えるのは努力だけ(handoff §7 ビジュアル方針)。
 *
 * 正誤・点数・XPは持たず、**連続日数**と**埋めた穴の数**だけを数える。
 * 祝福画面とホームのカウンターはこの2つで作る。
 */

export type LocalDate = string; // YYYY-MM-DD

const JST_OFFSET_MINUTES = 540;

/** UTCの瞬間を、ユーザーのローカル日付(既定JST)に落とす。 */
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
 * 連続日数。
 *
 * 「今日まだやっていない」だけで途切れた表示にすると、朝いちばんに
 * ホームを開いたユーザーを毎日がっかりさせる。**きのうまで続いていれば
 * 連続は生きている** 扱いにし、途切れるのは丸1日空いたときだけにする。
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
 * 祝福画面に出す一言。
 * 数字は「連続日数」と「埋めた穴」だけ。称賛は説明そのものに向ける。
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
