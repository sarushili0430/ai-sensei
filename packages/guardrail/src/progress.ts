/**
 * 数えるのは努力だけ(ビジュアル方針)。
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

export type PracticeProblemLike = { id: string };
export type PracticeAttemptLike = {
  problem_id: string;
  verdict: "correct" | "incorrect" | "unclear";
};

export type ProgressCounters = {
  streak_days: number;
  filled_holes: number;
  open_holes: number;
  solved_problems: number;
  open_problems: number;
  last_session_date: LocalDate | null;
};

/**
 * ホームのカウンター。
 *
 * **穴と復習問題は別々に数えて、足し合わせない**(ADR 0009)。同じ数字に混ぜると、
 * 移行の前後で「解けた問題数」が二重計上になる — 埋めた穴は埋めた穴のまま、
 * 新しく解いた問題は問題のまま数える。
 *
 * 引数をオブジェクトにしてあるのは、数える対象が3種類(セッション日・穴・復習問題)に
 * 増えて、位置引数では呼び出し側で取り違えるため。
 */
export function computeProgress(input: {
  sessionDates: readonly LocalDate[];
  today: LocalDate;
  /** @deprecated 旧データの穴。新しい画面は読まない(ADR 0009)。 */
  holes?: readonly HoleLike[];
  problems?: readonly PracticeProblemLike[];
  attempts?: readonly PracticeAttemptLike[];
}): ProgressCounters {
  const holes = input.holes ?? [];
  const problems = input.problems ?? [];
  const attempts = input.attempts ?? [];
  const sorted = [...new Set(input.sessionDates)].sort();

  // 数えるのは**問題**であって解答回数ではない。同じ1問に3回正解しても1。
  const solved = new Set(
    attempts.filter((attempt) => attempt.verdict === "correct").map((a) => a.problem_id),
  );
  return {
    streak_days: computeStreak(sorted, input.today),
    filled_holes: holes.filter((hole) => hole.status === "filled").length,
    open_holes: holes.filter((hole) => hole.status === "open").length,
    solved_problems: solved.size,
    // 未解答も不正解も `unclear` も、まだ解きにいく側。正解した問題だけが外れる。
    open_problems: problems.filter((problem) => !solved.has(problem.id)).length,
    last_session_date: sorted[sorted.length - 1] ?? null,
  };
}

// `celebrationHeadline` はここにあった。**消したのは、言っていることが嘘になったから。**
//
// 「穴が◯つ、埋まりました」「◯日つづけて説明できています」は、どちらも
// 教え返しと穴を前提にした文言で、ADR 0009 でその両方を畳んだ。祝福の見出しは
// 「お疲れ様」— **生徒が自分で「わかった」を押したのに、先輩の側が到達を判定する**
// 言い方をやめたため。文言はアプリ側(`AppStrings`)が正で、
// ここ(サーバ)には一度も呼ばれる経路が無かった。
