import { findTopic } from "@ai-sensei/curriculum";
import {
  type HoleLike,
  type LocalDate,
  type PracticeAttemptLike,
  type PracticeProblemLike,
  computeProgress,
  toLocalDate,
} from "./progress.ts";

export type ParentReportPeriod = {
  start_date: LocalDate;
  end_date: LocalDate;
};

export type ParentReportHoleLike = HoleLike & {
  topic_id: string;
  filled_at: string | null;
};

/**
 * @deprecated カルテは ADR 0009 で畳んだ。移行期の読み出し経路のためだけに残す。
 */
export type ParentReportKarteLike = {
  created_at: string;
  topic_ids: readonly string[];
  said_well: readonly string[];
};

export type ParentReportProblemLike = PracticeProblemLike & { topic_id: string };

export type ParentReportAttemptLike = PracticeAttemptLike & {
  answered_at: string;
  /** 本人が書いた答え。親レポートの引用はここから引く(ADR 0009)。 */
  response: string;
};

export type ParentReportLimits = {
  quoteCount: number;
  quoteLength: number;
  topicCount: number;
};

export type ParentReportSummary = {
  period: ParentReportPeriod;
  filled_holes: number;
  streak_days: number;
  explained_topics: { topic_id: string; name: string }[];
  quotes: string[];
};

/**
 * 「今月」を、作成日までの期間にする。
 *
 * 月末を返すと、8月11日に作ったレポートが「8月31日まで」の実績に見える。
 * 未来の学習まで含んだ印象を親へ渡さないため、終端は常に今日にする。
 */
export function currentMonthPeriod(today: LocalDate): ParentReportPeriod {
  return { start_date: `${today.slice(0, 7)}-01`, end_date: today };
}

/**
 * 親レポートの月次集計。ルートには計算を置かず、入力と上限を渡すだけにする。
 *
 * `limits` は contract の定数を呼び出し側から渡す。guardrail に同じ数をもう一度
 * 書くと、契約だけ変えた日にAPIが上限超過のJSONを返す。依存の向きは増やさず、
 * **数の正は contract、適用する責務はこの純関数**に分ける。
 */
export function computeParentReport(input: {
  today: LocalDate;
  sessionDates: readonly LocalDate[];
  /** @deprecated 旧データの穴。移行期だけ、単元名の根拠として混ぜる。 */
  holes?: readonly ParentReportHoleLike[];
  problems: readonly ParentReportProblemLike[];
  attempts: readonly ParentReportAttemptLike[];
  limits: ParentReportLimits;
  timezoneOffsetMinutes?: number;
}): ParentReportSummary {
  const holes = input.holes ?? [];
  const period = currentMonthPeriod(input.today);
  const progress = computeProgress({
    sessionDates: input.sessionDates,
    holes,
    problems: input.problems,
    attempts: input.attempts,
    today: input.today,
  });
  const timezoneOffsetMinutes = input.timezoneOffsetMinutes;

  const filledThisMonth = holes
    .filter((hole) => hole.status === "filled" && hole.filled_at !== null)
    .filter((hole) => {
      const filledDate = localDateOf(hole.filled_at, timezoneOffsetMinutes);
      return filledDate !== null && isInPeriod(filledDate, period);
    })
    .sort((a, b) => (b.filled_at ?? "").localeCompare(a.filled_at ?? ""));

  /**
   * 今月**正解した**解答(新しい順)。
   *
   * 同じ問題に何度も正解していても、数えるのは問題のほう(`solvedThisMonth`)。
   * 引用は解答ごとに拾うが、重複は下の `seenQuotes` が落とす。
   */
  const correctThisMonth = input.attempts
    .filter((attempt) => attempt.verdict === "correct")
    .filter((attempt) => {
      const answeredDate = localDateOf(attempt.answered_at, timezoneOffsetMinutes);
      return answeredDate !== null && isInPeriod(answeredDate, period);
    })
    .sort((a, b) => b.answered_at.localeCompare(a.answered_at));

  const problemById = new Map(input.problems.map((problem) => [problem.id, problem]));
  const solvedThisMonth = new Set(
    correctThisMonth
      .map((attempt) => attempt.problem_id)
      .filter((problemId) => problemById.has(problemId)),
  );

  /**
   * 「説明できるようになった」の根拠は2本だけに限定する。
   *   - 今月、復習問題に**正解した**(3日後・7日後に聞いても答えられた)
   *   - (移行期のみ)穴が今月 `filled` になった
   *
   * セッションに触れただけの単元は入れない。話題に出たことを
   * 「できるようになった」に昇格させないため。
   */
  const topicIds = [
    ...[...solvedThisMonth].map((problemId) => problemById.get(problemId)?.topic_id ?? ""),
    ...filledThisMonth.map((hole) => hole.topic_id),
  ];
  const explainedTopics: ParentReportSummary["explained_topics"] = [];
  const seenTopics = new Set<string>();
  for (const topicId of topicIds) {
    if (seenTopics.has(topicId)) continue;
    const topic = findTopic(topicId);
    // 未知IDを親にそのまま見せると「M1-...」という内部記号だけが届く。
    // 壊れた古い行は黙って単元名へ昇格させず、既知のカリキュラムだけを載せる。
    if (!topic) continue;
    seenTopics.add(topicId);
    explainedTopics.push({ topic_id: topic.id, name: topic.topic });
    if (explainedTopics.length >= normalizedLimit(input.limits.topicCount)) break;
  }

  /**
   * 引用は**本人が書いた答えのうち、正解したものだけ**(ADR 0009)。
   *
   * 旧 `kartes.said_well` はLLMが口頭の説明を要約したもので、**本人の言葉ではなかった**。
   * こちらはテキスト入力そのままなので、親が読むのは本人が打った文字になる。
   */
  const quotes: string[] = [];
  const seenQuotes = new Set<string>();
  for (const attempt of correctThisMonth) {
    const quote = attempt.response.trim();
    if (quote.length === 0 || seenQuotes.has(quote)) continue;
    /**
     * 長すぎる解答を途中で切らない。省略位置で意味が反転しうる文章を
     * 「本人の引用」と呼ぶほうが危険なので、上限を超えたものは載せない。
     */
    if (quote.length > normalizedLimit(input.limits.quoteLength)) continue;
    seenQuotes.add(quote);
    quotes.push(quote);
    if (quotes.length >= normalizedLimit(input.limits.quoteCount)) break;
  }

  return {
    period,
    // **足し合わせない。**移行期は穴と復習問題が両方あるが、混ぜると
    // 「今月できるようになったこと」が二重に数えられる(ADR 0009)。
    filled_holes: solvedThisMonth.size > 0 ? solvedThisMonth.size : filledThisMonth.length,
    streak_days: progress.streak_days,
    explained_topics: explainedTopics,
    quotes,
  };
}

function normalizedLimit(value: number): number {
  return Math.max(0, Math.floor(value));
}

function localDateOf(
  value: string | null,
  timezoneOffsetMinutes: number | undefined,
): LocalDate | null {
  if (value === null) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return toLocalDate(at, timezoneOffsetMinutes);
}

function isInPeriod(date: LocalDate, period: ParentReportPeriod): boolean {
  // YYYY-MM-DD は桁を固定しているので、文字列順と日付順が一致する。
  return date >= period.start_date && date <= period.end_date;
}
