import { z } from "zod";
import { topicIdSchema } from "./karte.ts";

/**
 * The parent report's contract (pivot plan §5-2).
 *
 * Only what may be shown belongs at this boundary. Parent-facing screens attract
 * demands for "easy numbers", and the temptation to add accuracy, comprehension
 * scores, deviation values and rankings later is strongest here. `.strict()`
 * rejects extra fields, and the numeric fields are closed to two: filled holes and
 * streak days. Listing banned fields in a comment helps neither type completion
 * nor runtime validation, so the representable states themselves - the locked
 * state included - are limited here.
 */

/** The maximum number of the student's own words shown to parents, from `said_well`. */
export const parentReportQuoteMaxCount = 3;

/**
 * The cap on one quote. Matched to `said_well`'s 200 characters, its source.
 * Truncating for sharing can change what the student meant, so the display side
 * never shortens it.
 */
export const parentReportQuoteMaxLength = 200;

/**
 * The cap that keeps a month from being crammed with units.
 * "What kinds of things they explained" at a glance beats exhaustiveness.
 */
export const parentReportTopicMaxCount = 12;
export const parentReportTopicNameMaxLength = 100;

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const parentReportPeriodSchema = z
  .object({
    /** The first day of this month (the user's local date). */
    start_date: localDateSchema,
    /** The creation date. Never look as if they studied to a month-end that has not arrived. */
    end_date: localDateSchema,
  })
  .strict();
export type ParentReportPeriod = z.infer<typeof parentReportPeriodSchema>;

export const parentReportTopicSchema = z
  .object({
    /** Content validity is matched by curriculum / guardrail. contract guards shape only. */
    topic_id: topicIdSchema,
    /** The unit name parents read. An id alone does not convey the difference from a paper test. */
    name: z.string().min(1).max(parentReportTopicNameMaxLength),
  })
  .strict();
export type ParentReportTopic = z.infer<typeof parentReportTopicSchema>;

export const parentReportSchema = z
  .object({
    period: parentReportPeriodSchema,
    /** Holes filled in this period. Only this month's, not the lifetime total. */
    filled_holes: z.number().int().min(0),
    /** The streak as of the creation date. The same counting as the existing progress. */
    streak_days: z.number().int().min(0),
    /** Unit names grounded in `said_well` or in holes filled this month. */
    explained_topics: z.array(parentReportTopicSchema).max(parentReportTopicMaxCount),
    /** The explanations the student actually spoke. Sourced only from the karte's `said_well`. */
    quotes: z
      .array(z.string().min(1).max(parentReportQuoteMaxLength))
      .max(parentReportQuoteMaxCount),
  })
  .strict();
export type ParentReport = z.infer<typeof parentReportSchema>;

const lockedParentReportResponseSchema = z
  .object({
    requires_premium: z.literal(true),
    /**
     * Free users also get a 200, but no body.
     * Independent boolean and nullable fields would allow "locked yet has a body",
     * making the paid boundary vary per client, so only this combination is allowed.
     */
    report: z.null(),
  })
  .strict();

const openParentReportResponseSchema = z
  .object({
    requires_premium: z.literal(false),
    report: parentReportSchema,
  })
  .strict();

/** The same locked representation as `/v1/me/reviews`, so free users get no error. */
export const parentReportResponseSchema = z.discriminatedUnion("requires_premium", [
  lockedParentReportResponseSchema,
  openParentReportResponseSchema,
]);
export type ParentReportResponse = z.infer<typeof parentReportResponseSchema>;
