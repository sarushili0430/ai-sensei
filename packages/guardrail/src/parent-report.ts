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
 * Makes "this month" the period up to the creation date.
 *
 * Returning the month's end would make a report created on 11 August look like
 * results "through 31 August". The end is always today, so parents are never given
 * the impression of study that has not happened.
 */
export function currentMonthPeriod(today: LocalDate): ParentReportPeriod {
  return { start_date: `${today.slice(0, 7)}-01`, end_date: today };
}

/**
 * The parent report's monthly rollup. No computation lives in the route; it just
 * passes the inputs and the caps.
 *
 * `limits` comes from contract's constants via the caller. Writing the same numbers
 * again in guardrail would make the API return over-cap JSON on the day only the
 * contract changed. Rather than adding a dependency, the split is: contract owns
 * the numbers, this pure function owns applying them.
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
   * "Now able to explain it" rests on exactly two grounds:
   *   - a hole became `filled` this month (they stalled before, and explained it now)
   *   - a unit covered in a karte that has `said_well` (their explanation really remains)
   *
   * Units merely touched in a session are excluded from the latter, so having come
   * up in conversation is never promoted to "now able to do it".
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
    // Showing an unknown id to a parent delivers only the internal token "M1-...".
    // Broken old rows are not silently promoted to a unit name; only known curriculum entries are listed.
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
       * Never truncate an over-long old row. Calling text whose meaning can invert
       * at the cut point "the student's own quote" is more dangerous, so rows
       * outside the contract are omitted.
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
  // YYYY-MM-DD has fixed widths, so string order matches date order.
  return date >= period.start_date && date <= period.end_date;
}
