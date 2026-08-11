import { findTopic } from "@ai-sensei/curriculum";
import { type HoleLike, type LocalDate, computeProgress, toLocalDate } from "./progress.ts";

export type ParentReportPeriod = {
  start_date: LocalDate;
  end_date: LocalDate;
};

export type ParentReportHoleLike = HoleLike & {
  topic_id: string;
  filled_at: string | null;
};

export type ParentReportKarteLike = {
  created_at: string;
  topic_ids: readonly string[];
  said_well: readonly string[];
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
  holes: readonly ParentReportHoleLike[];
  kartes: readonly ParentReportKarteLike[];
  limits: ParentReportLimits;
  timezoneOffsetMinutes?: number;
}): ParentReportSummary {
  const period = currentMonthPeriod(input.today);
  const progress = computeProgress(input.sessionDates, input.holes, input.today);
  const timezoneOffsetMinutes = input.timezoneOffsetMinutes;

  const filledThisMonth = input.holes
    .filter((hole) => hole.status === "filled" && hole.filled_at !== null)
    .filter((hole) => {
      const filledDate = localDateOf(hole.filled_at, timezoneOffsetMinutes);
      return filledDate !== null && isInPeriod(filledDate, period);
    })
    .sort((a, b) => (b.filled_at ?? "").localeCompare(a.filled_at ?? ""));

  const kartesThisMonth = input.kartes
    .filter((karte) => {
      const createdDate = localDateOf(karte.created_at, timezoneOffsetMinutes);
      return createdDate !== null && isInPeriod(createdDate, period);
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  /**
   * 「説明できるようになった」の根拠は2本だけに限定する。
   *   - 穴が今月 `filled` になった(前は止まり、今は説明できた)
   *   - `said_well` があるカルテで扱った単元(本人の説明が実際に残った)
   *
   * セッションに触れただけの単元は後者から外す。話題に出たことを
   * 「できるようになった」に昇格させないため。
   */
  const topicIds = [
    ...filledThisMonth.map((hole) => hole.topic_id),
    ...kartesThisMonth.flatMap((karte) => (karte.said_well.length > 0 ? [...karte.topic_ids] : [])),
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

  const quotes: string[] = [];
  const seenQuotes = new Set<string>();
  for (const karte of kartesThisMonth) {
    for (const rawQuote of karte.said_well) {
      const quote = rawQuote.trim();
      if (quote.length === 0 || seenQuotes.has(quote)) continue;
      /**
       * 長すぎる古い行を途中で切らない。省略位置で意味が反転しうる文章を
       * 「本人の引用」と呼ぶほうが危険なので、契約外の行は載せない。
       */
      if (quote.length > normalizedLimit(input.limits.quoteLength)) continue;
      seenQuotes.add(quote);
      quotes.push(quote);
      if (quotes.length >= normalizedLimit(input.limits.quoteCount)) break;
    }
    if (quotes.length >= normalizedLimit(input.limits.quoteCount)) break;
  }

  return {
    period,
    filled_holes: filledThisMonth.length,
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
