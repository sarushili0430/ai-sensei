import { z } from "zod";

/**
 * The karte (post-session feedback).
 *
 * Design promises:
 *   - no fields for scores or accuracy. Only streak days and filled holes are counted.
 *   - a "hole" is not lost marks but a place about to be filled.
 *   - answers and worked solutions do not belong here (so the answer is not given away).
 *
 * Origin: the evaluation rubric.
 */

/**
 * The shape of a topic_id. Whether the content is in the curriculum is matched by
 * @ai-sensei/guardrail.
 *
 * Prefixes are per curriculum: `M1`-`MC` is Japanese high-school maths (Math I-C),
 * `J1`-`J3` Japanese middle-school maths (grades 1-3), `JE` Japanese
 * middle-school English (not split by grade), `E1`/`E2`/`L1` Japanese high-school
 * English, and `A1` (Algebra 1), `GE` (Geometry), `A2` (Algebra 2), `PC`
 * (Precalculus), `CL` (Calculus) and `ST` (Statistics) the overseas curricula.
 *
 * Keep this identical to `topicIdPattern` in `@ai-sensei/curriculum`.
 * contract is a dependency-free layer and cannot reference it, so it is written
 * twice (drift fails backend/api's photo-analysis tests).
 */
export const topicIdSchema = z
  .string()
  .regex(/^(M1|MA|M2|MB|M3|MC|A1|GE|A2|PC|CL|ST|J1|J2|J3|JE|E1|E2|L1)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/);

/**
 * A hole's depth. Not a score but a sense of "how much this affects what's next",
 * used to prioritise reviews. Never surfaced as a number in the UI; it only affects
 * ordering.
 */
export const holeSeverities = ["low", "medium", "high"] as const;
export const holeSeveritySchema = z.enum(holeSeverities);
export type HoleSeverity = (typeof holeSeverities)[number];

export const holeDraftSchema = z
  .object({
    topic_id: topicIdSchema,
    /** What could not be explained. Written as "the explanation stalled at ..." (never blaming). */
    desc: z.string().min(1).max(200),
    severity: holeSeveritySchema,
    /** The transcript utterance behind it. Not shown on the karte screen, but used as context when re-explaining. */
    evidence: z.string().max(500).optional(),
    /**
     * The one question asked after 1/3/7 days. Short enough to answer in 10 seconds.
     *
     * It is drawn only from the parts of the transcript the student explained
     * (`ユーザー:` / `Student:`), never from what the senpai taught - that would
     * reinforce an AI misreading three times through spaced repetition (the
     * rejected column of pivot plan §2).
     *
     * There is no grading and no answer stored. The student just picks "said it /
     * not yet". Old data lacks it, so it is optional, and `desc` is used as the
     * question when absent.
     */
    quiz: z.string().min(1).max(200).optional(),
  })
  .strict();
export type HoleDraft = z.infer<typeof holeDraftSchema>;

export const holeStatuses = ["open", "filled"] as const;
export const holeStatusSchema = z.enum(holeStatuses);

/**
 * A hole's review outcome. Not grading but the student's own yes/no on whether
 * they could say it.
 *
 * The UI carries no wording that scolds picking `not_yet`. Promise 3, "never shame
 * a pass", holds in reviews too.
 */
export const reviewOutcomes = ["said_it", "not_yet"] as const;
export const reviewOutcomeSchema = z.enum(reviewOutcomes);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

/**
 * A stored hole. The unit of the review flow.
 *
 * `status` and `filled_at` always move together. With only one set, the review
 * queue (filtered by status) and the filled-holes counter (based on filled_at)
 * would report different numbers, so the schema binds the combination.
 */
export const holeSchema = holeDraftSchema
  .extend({
    id: z.string().min(1),
    status: holeStatusSchema,
    created_at: z.string().datetime(),
    /** When it was filled by re-explaining. The source data for the filled-holes counter. */
    filled_at: z.string().datetime().nullable(),
  })
  .strict()
  .refine((hole) => (hole.status === "filled") === (hole.filled_at !== null), {
    message: "status=filled のときだけ filled_at を入れてください",
    path: ["filled_at"],
  });
export type Hole = z.infer<typeof holeSchema>;

/** The pre-save karte the agent generates from the whole transcript. */
export const karteDraftSchema = z
  .object({
    /** What they said well. Highlighted in yellow on the karte screen. */
    said_well: z.array(z.string().min(1).max(200)).max(10),
    holes: z.array(holeDraftSchema).max(5),
    /** Confused terminology. A short note such as "mixed up 'quadratic formula' and 'discriminant'". */
    term_notes: z.array(z.string().min(1).max(200)).max(5),
    /** The agent's follow-up question (a Premium feature). Not generated for free users. */
    followup_question: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();
export type KarteDraft = z.infer<typeof karteDraftSchema>;

/** The stored karte. What the karte screen and history read. */
export const karteSchema = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    created_at: z.string().datetime(),
    /** The units covered in that session. Shown in the karte screen's header. */
    topic_ids: z.array(topicIdSchema).min(1),
    // Length constraints match the draft. Looser only after saving would make the
    // fixture and the JSON Schema disagree on what is allowed (one side letting
    // through empty strings or long text).
    said_well: z.array(z.string().min(1).max(200)).max(10),
    holes: z.array(holeSchema).max(5),
    term_notes: z.array(z.string().min(1).max(200)).max(5),
    followup_question: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type Karte = z.infer<typeof karteSchema>;

/**
 * The home screen's counters.
 * No XP, levels or scores (the principle: count only effort).
 */
export const progressSchema = z
  .object({
    /** Streak days. */
    streak_days: z.number().int().min(0),
    /** Lifetime filled holes. This app's own score, meant for shared screenshots. */
    filled_holes: z.number().int().min(0),
    /** How many holes are still open. */
    open_holes: z.number().int().min(0),
    /** The last day a session was completed (local date YYYY-MM-DD). */
    last_session_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .strict();
export type Progress = z.infer<typeof progressSchema>;
