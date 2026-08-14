import { z } from "zod";
import {
  holeSchema,
  karteDraftSchema,
  karteSchema,
  progressSchema,
  reviewOutcomeSchema,
  topicIdSchema,
} from "./karte.ts";
import { planDateSchema, planSourceSchema, studyPlanDraftSchema, studyPlanSchema } from "./plan.ts";

/**
 * The contract between backend/api, apps/mobile and the agent.
 * Change this and update fixtures/ too (fixtures are read by Flutter tests as well).
 */

export const apiPaths = {
  createSession: "/v1/sessions",
  updateSessionTopics: (sessionId: string) => `/v1/sessions/${sessionId}/topics`,
  startSession: (sessionId: string) => `/v1/sessions/${sessionId}/start`,
  completeSession: (sessionId: string) => `/v1/sessions/${sessionId}/complete`,
  progress: "/v1/me/progress",
  reviewQueue: "/v1/me/reviews",
  answerReview: (holeId: string) => `/v1/me/reviews/${holeId}`,
  revenueCatWebhook: "/v1/webhooks/revenuecat",
  parentReport: "/v1/me/parent-report",
  createPlanSession: "/v1/plans",
  completePlanSession: (planSessionId: string) => `/v1/plans/${planSessionId}/complete`,
  plan: "/v1/me/plan",
} as const;

export const locales = ["ja", "en"] as const;
export const localeSchema = z.enum(locales);
export type Locale = (typeof locales)[number];

/** Session kinds. A review starts from an existing hole, so it needs no photo. */
export const sessionKinds = ["new", "review"] as const;
export const sessionKindSchema = z.enum(sessionKinds);

/* -------------------------------------------------------------------------- */
/* Problem text (grounding)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The multipart part names for POST /v1/sessions.
 *
 * The two photos are treated as different things, because their lifetimes differ.
 *
 * | part | content | stored |
 * | --- | --- | --- |
 * | `photo` | the student's notes (their own work) | stored in R2 |
 * | `problem_photo` | a textbook or workbook page (someone else's work) | discarded after analysis; never stored |
 *
 * Plan §4-1 said "send it for analysis, but decide separately whether to keep it
 * in R2 (discard-after-analysis stays defensible in future publisher talks)", and
 * §10-4 left it open. Discarding is now the default, so the part names are split
 * to make the lifetime visible to the sender as well.
 *
 * `kind: "new"` needs only one of the two; reject only when both are missing.
 * Neither is required on its own:
 *
 *   - `problem_photo` only ... a problem not yet attempted. `visible_work` is
 *     empty and `sessionMetadataSchema.visible_work` gets the placeholder meaning
 *     "no notes photo"
 *   - `photo` only ... one image holding both the problem and the notes (the case
 *     §4-1 calls common). The analyser tries to read the problem from the notes
 *     photo and proceeds without it if unreadable
 *
 * Back when notes were mandatory, this contract broke its own discard promise: a
 * student with no notes had no way to send anything but the page in `photo` (the
 * notes slot), so someone else's copyrighted work ended up stored in R2. The only
 * way to guarantee discarding was to remove the motive for putting a page in the
 * notes slot, so notes stopped being required.
 *
 * That this legitimises students who do not photograph their notes is accepted.
 * Mandatory notes followed necessarily from the old policy (never give the answer,
 * make them explain), but this is now a product that teaches, and "I can't even
 * start" is a central tutoring request (the revision of promise 1, deck §0). The
 * insurance against misreading lives in the teach-back phase and is untouched (§1-1).
 *
 * The remaining hole: a student who puts the problem in the `photo` slot has it
 * stored as notes. Slot confusion cannot be prevented - only the motive for it,
 * and that has been removed.
 *
 * That motive was removed in the contract only, and lingered in the UI for a
 * while. The capture screen opened the notes camera the moment it was entered, so
 * a student with no notes stood at the shutter without ever seeing the problem
 * slot and put the page they had into the notes slot. It now shows the slots
 * first and makes the student choose, closing that too (`capture_screen.dart`).
 * When rebuilding the entrance, treat "do not open the camera automatically" as
 * part of the discard promise.
 */
export const sessionPhotoParts = {
  /** The notes photo. Stored in R2. */
  notes: "photo",
  /** The problem photo. Discarded after analysis. */
  problem: "problem_photo",
} as const;

/**
 * The cap on the transcribed problem text.
 *
 * A high-school maths question fits in about 300 characters even with sub-parts.
 * 600 is a safety valve against transcribing the whole page, not a target.
 * Capturing a full page lets the chapter's answers and commentary flow in as
 * problem text, and the lesson starts with the senpai reading out the answer.
 */
export const problemTextMaxLength = 600;

/**
 * Which photo the problem text was read from.
 *
 * Where to put the hint was decided as "before capture" (2026-08-10). This field
 * was originally added so a hint could be shown only when it is `null`
 * (unreadable), but that is *after* analysis. A post-analysis hint acts as a
 * warning that only clears by retaking, making the supposedly optional second
 * photo effectively required - the UI cancelling out the API's decision not to
 * return 422 when the second photo is broken. Before capture the same wording is
 * pure encouragement, so "the senpai gets less lost if the problem is in shot too"
 * can be shown while keeping §4-1's "do not require two photos".
 * So the app shows the hint on the capture confirmation screen, and this field
 * does not gate anything.
 *
 * The screen picks its hint from which slots are filled (someone with no photos
 * yet gets "either one is enough to start"; someone with only notes gets the
 * encouragement above). Both appear before capture, so they are a different axis
 * from "showing it after analysis makes the second photo required".
 *
 * This field now exists for observation.
 *
 * How many students actually send two photos is observable only from this value.
 */
export const problemSources = ["problem_photo", "notes_photo"] as const;
export const problemSourceSchema = z.enum(problemSources);
export type ProblemSource = (typeof problemSources)[number];

/**
 * The problem this session covers. Exists only when it was readable.
 *
 * `text` and `source` are one object so that "text without a source" cannot be
 * expressed (the same idea as binding `karte.ts`'s `status` / `filled_at` together).
 */
export const sessionProblemSchema = z
  .object({
    /**
     * The problem text. Answers and commentary do not belong here.
     * Whether the content really is a question is not contract's job (the same
     * split as `topicIdSchema`; it belongs to `@ai-sensei/guardrail`).
     */
    text: z.string().min(1).max(problemTextMaxLength),
    source: problemSourceSchema,
  })
  .strict();
export type SessionProblem = z.infer<typeof sessionProblemSchema>;

/** A unit detected by photo analysis. Shown as chips in the UI and correctable by the user. */
export const detectedTopicSchema = z
  .object({
    topic_id: topicIdSchema,
    course: z.string().min(1),
    unit: z.string().min(1),
    topic: z.string().min(1),
    /**
     * The short curriculum name for the chip: "Grade 7", "Math I", "Algebra 2".
     *
     * Computed and passed by the server. Deriving it on the device from the
     * topic_id prefix would make a fourth prefix table. Middle-school English also
     * has no per-grade prefixes (the grade is display guidance only, deliberately
     * not split), so "Grade 8" cannot be built from a prefix.
     */
    label: z.string().min(1).max(16),
    /** 0..1. Low ones are listed as candidates rather than pre-selected. */
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type DetectedTopic = z.infer<typeof detectedTopicSchema>;

/**
 * The school stage. Used to halve the curricula considered during photo analysis
 * and plan interviews.
 *
 * Sent by the device from its settings. Not held in the DB - reinstalling means
 * choosing again, in exchange for needing no migration (ADR 0007).
 *
 * Defaults to `high_school`. Older apps that do not send it keep seeing only the
 * high-school curricula, as before.
 */
export const schoolStages = ["junior_high", "high_school"] as const;
export type SchoolStage = (typeof schoolStages)[number];
export const schoolStageSchema = z.enum(schoolStages);

/**
 * The POST /v1/sessions request.
 * The photos themselves go in the multipart `photo` part; the remaining fields go
 * in the `meta` part as this JSON.
 */
export const createSessionRequestSchema = z
  .object({
    kind: sessionKindSchema.default("new"),
    locale: localeSchema.default("ja"),
    school_stage: schoolStageSchema.default("high_school"),
    /** For kind="review", the hole to fill. Required, since a review starts from a hole. */
    hole_id: z.string().min(1).optional(),
    /** Set when the user corrected the unit in the chip UI. Empty leaves it to photo analysis. */
    topic_ids: z.array(topicIdSchema).max(5).optional(),
  })
  .strict()
  .refine((request) => request.kind !== "review" || request.hole_id !== undefined, {
    message: "kind=review には hole_id が必要です",
    path: ["hole_id"],
  });

/**
 * The type *after* parsing. `kind`/`locale` always exist because their defaults
 * apply. Server-side code uses this one.
 */
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

/**
 * The type *before* parsing (on the wire). `kind`/`locale` may be omitted.
 * Clients building a request use this one.
 */
export type CreateSessionRequestInput = z.input<typeof createSessionRequestSchema>;

export const liveKitConnectionSchema = z
  .object({
    url: z.string().url(),
    /** The join token. Short-lived (session length plus buffer). */
    token: z.string().min(1),
    room: z.string().min(1),
  })
  .strict();

export const sessionLimitsSchema = z
  .object({
    /** The server-enforced cap. Free and Premium alike get 20 minutes, enough for a 15-20 minute lesson. */
    max_seconds: z.number().int().positive(),
    /**
     * Whether another lesson can start today, as of this response.
     * To uphold §6-3 ("never show numbers in the UI") in the contract's shape, it
     * returns only a yes/no, never a remaining count.
     */
    lesson_allowed_today: z.boolean(),
  })
  .strict();

/**
 * The POST /v1/sessions response. Only the result of reading the photo; it holds
 * no room key.
 *
 * The absence of `livekit` and `limits` is by design. Daily uses are counted when
 * the conversation starts, not when the photo is read
 * (`startSessionResponseSchema`), so the analysis response never goes through the
 * slot check.
 *
 * Handing out a token at analysis time would break that split: holding a token
 * means being able to start any time, so giving the key first and then saying
 * "counted at conversation start" puts the counter on the client. So claiming the
 * slot and issuing the token are bound into the single operation
 * `POST /v1/sessions/{id}/start`, and this response returns only the unit and a
 * read-back of the problem text.
 */
export const createSessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    kind: sessionKindSchema,
    detected_topics: z.array(detectedTopicSchema).min(1),
    /**
     * The problem the analysis read. `null` if unreadable (the session still stands).
     *
     * It goes back to the app for two reasons:
     *   1. only when `null`, show §4-1's hint ("the senpai gets less lost if...")
     *   2. show the transcribed problem text verbatim - the earliest point at which
     *      a misreading surfaces. The pre-lesson countermeasure to §1-1's "the more
     *      an app is built around AI understanding, the more fatal a misreading is"
     */
    problem: sessionProblemSchema.nullable(),
  })
  .strict();
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

/**
 * The POST /v1/sessions/{id}/start request.
 *
 * `locale` is used only for the language of error messages. The conversation's
 * language comes from the curriculum of the unit stored on the session (switching
 * the device to English never brings an English teacher to a problem photographed
 * in Japanese).
 */
export const startSessionRequestSchema = z.object({ locale: localeSchema.default("ja") }).strict();
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;
export type StartSessionRequestInput = z.input<typeof startSessionRequestSchema>;

/**
 * The POST /v1/sessions/{id}/start response. The only place a use is counted.
 *
 * Previously the daily slot was claimed when the photo was read
 * (`POST /v1/sessions`), because that is where the cost (Vision LLM) occurred -
 * but that left someone who only took a photo and confirmed the unit being told
 * "that's it for today" without a single conversation. To a student one use means
 * one conversation with the senpai, so counting moved here.
 *
 * Claiming the slot and issuing the token are one server-side operation, in an
 * order that cannot be swapped: no slot means no token, and a token means the slot
 * was taken. (Racking up cost by repeating analysis alone is blocked by a separate
 * cap on the `POST /v1/sessions` side - one far looser than the daily lesson
 * count, stopping only abuse.)
 *
 * A resend does not count twice. Calling it a second time for the same session
 * reissues only the token against the slot already claimed (for retries after a
 * dropped connection).
 */
export const startSessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    kind: sessionKindSchema,
    livekit: liveKitConnectionSchema,
    limits: sessionLimitsSchema,
  })
  .strict();
export type StartSessionResponse = z.infer<typeof startSessionResponseSchema>;

/**
 * The PATCH /v1/sessions/{id}/topics request.
 *
 * Applies units removed in the chip UI without recreating the session.
 * Recreating would push the same photo through the Vision LLM again (doubling the
 * cost) and hit the analysis-count cap twice.
 */
export const updateSessionTopicsRequestSchema = z
  .object({
    locale: localeSchema.default("ja"),
    /** The units to keep. Must be a subset of those detected by the analysis. */
    topic_ids: z.array(topicIdSchema).min(1).max(5),
  })
  .strict();
export type UpdateSessionTopicsRequest = z.infer<typeof updateSessionTopicsRequestSchema>;
export type UpdateSessionTopicsRequestInput = z.input<typeof updateSessionTopicsRequestSchema>;

/**
 * The same shape as at creation (the unit and a read-back of the problem text).
 * No token here either - the room key comes only from `/start`.
 */
export type UpdateSessionTopicsResponse = CreateSessionResponse;

/**
 * The conversation context handed to the agent on the LiveKit token.
 *
 * It rides the token's `metadata` claim (and, for named workers, the dispatch
 * job's metadata) as a JSON string rather than an HTTP body. So it does not appear
 * in the endpoint table, yet it is the heaviest contract between backend/api and
 * the agent: it flows straight into the conversation prompt's blanks.
 *
 * Running without a type here is why the agent reused `photo_summary` as
 * `problem_text` (= the senpai taught without seeing the problem itself). §0's
 * decision 4, "send the problem and the notes together", was unimplemented
 * because this field did not exist.
 *
 * The string fields are pre-formatted and pasted straight into the prompt.
 * Placeholders for empty values included, they are written in `locale`'s language
 * (a Japanese "(none)" mixed into an English prompt makes that part answer in
 * Japanese).
 */
export const sessionMetadataSchema = z
  .object({
    session_id: z.string().min(1),
    /**
     * The conversation's language. Not the app's display language - it follows the
     * curriculum of the unit covered (ADR 0005). For reviews it comes from the
     * prefix of the topic_id on the hole.
     */
    locale: localeSchema,
    kind: sessionKindSchema,
    max_seconds: z.number().int().positive(),
    /** The photo analysis summary. What is in the picture, not the problem text. */
    photo_summary: z.string(),
    /**
     * The problem text. Never an empty string (`.min(1)`).
     *
     * When unreadable it still arrives with that language's placeholder filled in
     * (in Japanese, "(no problem photo)"). The agent need not fill blanks. Two fill
     * sites would make the wording the prompt expects differ from what arrives, and
     * the senpai would start reconstructing the problem by guesswork
     * (`prompts/senpai_board.*.md` matches this placeholder by name).
     */
    problem_text: z.string().min(1),
    /**
     * What is written in the notes (pre-formatted bullets). Never empty (`.min(1)`).
     *
     * Handled like `problem_text`, and arrives so three states stay distinguishable:
     *
     *   - bullets ... read from the notes photo
     *   - the equivalent of "(none)" ... notes were photographed, but no sign of
     *     work could be read
     *   - the equivalent of "(no notes photo)" ... there is no notes photo at all
     *     (only the problem was brought = not attempted yet; see `sessionPhotoParts`)
     *
     * The third state appeared once the problem-photo-only path was legitimised,
     * and it differs from "could not be read". Conflated, the senpai treats "a
     * student who wrote nothing" the same as "a student who took no notes photo".
     */
    visible_work: z.string().min(1),
    /** Pre-formatted bullets. */
    question_seeds: z.string(),
    /** The pre-formatted list of allowed topics (with learning goals). */
    allowed_topics: z.string(),
    /** The raw ids used for guardrail matching. Includes prerequisite topics. */
    allowed_topic_ids: z.array(topicIdSchema),
    is_premium: z.boolean(),
    /**
     * For a review, only the hole being retaught this time. The new API sends one
     * for a review and `null` for a new lesson.
     *
     * Stuffing the hole's description into `problem_text` is rejected: a review has
     * no problem photo, and disguising it as problem text would void the boundary
     * in `senpai_board.*.md` that says "do not invent a problem that is not in the
     * photo". Photo facts and observations from the previous explanation stay
     * separate in the type too.
     *
     * It carries only `desc` and `evidence`, not the whole previous karte. Passing
     * `said_well` or other holes widens a one-hole review into a re-lecture of the
     * entire previous session. `topic_id` marks the subject, while the prerequisite
     * range actually allowed remains `allowed_topic_ids`. Content matching is kept
     * out of here to preserve the dependency direction: contract owns structure and
     * caps, guardrail owns matching.
     *
     * The field itself is optional for rolling deploys. The API and the agent ship
     * separately, so in the window where a new agent ships first, old-API metadata
     * lacks this field. `undefined` must be readable, and the agent degrades to the
     * old board-less conversation.
     */
    review_hole: z
      .object({
        topic_id: topicIdSchema,
        desc: z.string().min(1).max(200),
        evidence: z.string().max(500).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((metadata) => metadata.kind === "review" || metadata.review_hole == null, {
    message: "review でないときは review_hole を入れないでください",
    path: ["review_hole"],
  });
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

/** The conversation log. assistant = the agent's speech, user = the student's explanation. */
export const transcriptMessageSchema = z
  .object({
    role: z.enum(["assistant", "user"]),
    text: z.string(),
    /** Milliseconds elapsed since the session started. */
    at_ms: z.number().int().min(0),
    /** The unit that utterance covered (always present on the agent's questions). */
    topic_id: topicIdSchema.optional(),
  })
  .strict();
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

/**
 * POST /v1/sessions/{id}/complete - called by the agent.
 * An internal call, so Authorization: Bearer <INTERNAL_API_TOKEN> is required.
 */
export const completeSessionRequestSchema = z
  .object({
    transcript: z.array(transcriptMessageSchema),
    karte: karteDraftSchema,
    duration_seconds: z.number().int().min(0),
    /** Set when the conversation was cut short. A karte is still made, with holes weighted more cautiously. */
    ended_reason: z.enum(["completed", "timeout", "user_left", "error"]),
    /**
     * The student's self-report, meaningful only for `kind: "review"` sessions.
     * Omitted by default, which means "do not fill". A hole is filled only when
     * `"said_it"` is explicit. A session that merely connected (no speech,
     * `ended_reason: "user_left"`) leaves this unset and the hole stays open.
     */
    review_outcome: reviewOutcomeSchema.optional(),
  })
  .strict();
export type CompleteSessionRequest = z.infer<typeof completeSessionRequestSchema>;

/** A booked review push. Spaced repetition runs in three steps: +1, +3, +7 days. */
export const reviewScheduleEntrySchema = z
  .object({
    hole_id: z.string().min(1),
    /** 1 = +1 day / 2 = +3 days / 3 = +7 days */
    step: z.number().int().min(1).max(3),
    scheduled_at: z.string().datetime(),
  })
  .strict();
export type ReviewScheduleEntry = z.infer<typeof reviewScheduleEntrySchema>;

export const completeSessionResponseSchema = z
  .object({
    karte: karteSchema,
    review_schedule: z.array(reviewScheduleEntrySchema),
    progress: progressSchema,
    /** Whether to show the paywall right after the first karte (the server decides where). */
    show_paywall: z.boolean(),
  })
  .strict();
export type CompleteSessionResponse = z.infer<typeof completeSessionResponseSchema>;

/** The queue read by the review screen (entered from a push). */
export const reviewQueueItemSchema = z
  .object({
    hole: holeSchema,
    topic_id: topicIdSchema,
    /** Used to display "3 days ago". */
    days_since: z.number().int().min(0),
    /** The same one-liner in the agent's voice as the notification. */
    prompt: z.string().min(1).max(200),
    /**
     * One question answered in 10 seconds. Required in the response; the server
     * resolves old data's `hole.quiz ?? hole.desc`. A client-side branch would show
     * a different question per screen.
     */
    quiz: z.string().min(1).max(200),
  })
  .strict();
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

/**
 * A filled hole. There is no separate history screen; they live in the bottom half
 * of the free review screen (holes to fill / holes filled). Progress earned in the
 * quiz stacks up in the same place.
 */
export const filledHoleSchema = z
  .object({
    hole: holeSchema,
    topic_id: topicIdSchema,
    /** Used to display "filled yesterday". */
    days_since_filled: z.number().int().min(0),
  })
  .strict();
export type FilledHole = z.infer<typeof filledHoleSchema>;

/** The maximum number of filled holes the review screen receives at once. */
export const filledHolesLimit = 30;

export const reviewQueueResponseSchema = z
  .object({
    items: z.array(reviewQueueItemSchema),
    /**
     * Filled holes, newest first. The lifetime count is authoritative in
     * progress.filled_holes; this carries at most {@link filledHolesLimit} entries.
     */
    filled: z.array(filledHoleSchema).max(filledHolesLimit),
  })
  .strict();
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

/** The quiz self-report. The server does not grade; it just takes the student's yes/no. */
export const reviewAnswerRequestSchema = z.object({ outcome: reviewOutcomeSchema }).strict();
export type ReviewAnswerRequest = z.infer<typeof reviewAnswerRequestSchema>;

/** The response that updates the hole and the home counters right after a self-report. */
export const reviewAnswerResponseSchema = z
  .object({ hole: holeSchema, progress: progressSchema })
  .strict();
export type ReviewAnswerResponse = z.infer<typeof reviewAnswerResponseSchema>;

export const progressResponseSchema = z
  .object({
    progress: progressSchema,
    is_premium: z.boolean(),
    limits: sessionLimitsSchema,
  })
  .strict();
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

/** Errors. Clients branch on code (message is for display and may change). */
export const apiErrorCodes = [
  "unauthorized",
  "free_limit_reached",
  "fair_use_limit_reached",
  "premium_required",
  "photo_unreadable",
  "out_of_scope",
  "session_not_found",
  "hole_not_found",
  "rate_limited",
  "internal_error",
] as const;
export const apiErrorCodeSchema = z.enum(apiErrorCodes);
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        /** Japanese/English text shown to the user as-is. Written without nagging. */
        message: z.string().min(1),
        /** Rough seconds before retrying (for the daily cap / rate_limited). */
        retry_after_seconds: z.number().int().min(0).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

/* -------------------------------------------------------------------------- */
/* Plan mode                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `plan` is not added to `sessionKinds`; plans are a dedicated session type.
 *
 * A lesson session's `kind` is tied to D1's CHECK constraint and to
 * {@link sessionMetadataSchema}'s `problem_text` / `visible_work` /
 * `allowed_topic_ids`. Mixing plans in would mean rebuilding the live `sessions`
 * table or making every required lesson context optional. The former breaks the
 * old Worker mid-deploy; the latter re-permits "teach without seeing the problem"
 * in the type. Plans are also rebuilt repeatedly and live on, so they are not the
 * kind of thing counted in lesson totals or streaks. Preserving the lifetime and
 * accounting boundary won over sharing LiveKit, so the contracts are separate.
 */
export const createPlanSessionRequestSchema = z
  .object({
    locale: localeSchema.default("ja"),
    school_stage: schoolStageSchema.default("high_school"),
  })
  .strict();
export type CreatePlanSessionRequest = z.infer<typeof createPlanSessionRequestSchema>;
export type CreatePlanSessionRequestInput = z.input<typeof createPlanSessionRequestSchema>;

/** The plan-mode conversation context carried on the LiveKit token. */
export const planSessionMetadataSchema = z
  .object({
    plan_session_id: z.string().min(1),
    /** A discriminator that catches confusion with lesson metadata at the agent's entrance. */
    kind: z.literal("plan"),
    locale: localeSchema,
    /**
     * The school stage: the range of units a plan may cover.
     *
     * Lesson metadata has no such field (there, the curriculum is derivable from
     * `allowed_topic_ids`'s prefix). A plan has no photo and no settled scope, so
     * the stage must be known before pasting a whole curriculum.
     *
     * This schema is `.strict()`, and old agents fail to parse unknown keys, so
     * deploy the agent before the API.
     */
    school_stage: schoolStageSchema,
    max_seconds: z.number().int().positive(),
    /** The API-settled local date, so the LLM never guesses relative dates. */
    today: planDateSchema,
    /** The current plan, pinned at conversation start, so a rebuild need not re-ask the facts. */
    current_plan: studyPlanSchema.nullable(),
  })
  .strict();
export type PlanSessionMetadata = z.infer<typeof planSessionMetadataSchema>;

export const createPlanSessionResponseSchema = z
  .object({
    plan_session_id: z.string().min(1),
    livekit: liveKitConnectionSchema,
    /** The screen can tell "new" from "rebuild" on the same fact, before connecting. */
    current_plan: studyPlanSchema.nullable(),
  })
  .strict();
export type CreatePlanSessionResponse = z.infer<typeof createPlanSessionResponseSchema>;

/**
 * POST /v1/plans/{id}/complete - called by the plan agent with the internal token.
 * The LLM's shape is accepted as {@link studyPlanDraftSchema}; ids, timestamps and
 * status are added by the API alone.
 */
export const completePlanSessionRequestSchema = z
  .object({
    plan: studyPlanDraftSchema,
    source: planSourceSchema,
    duration_seconds: z.number().int().min(0),
    ended_reason: z.enum(["completed", "timeout", "user_left", "error"]),
  })
  .strict();
export type CompletePlanSessionRequest = z.infer<typeof completePlanSessionRequestSchema>;

export const completePlanSessionResponseSchema = z
  .object({
    plan: studyPlanSchema,
  })
  .strict();
export type CompletePlanSessionResponse = z.infer<typeof completePlanSessionResponseSchema>;

/** GET /v1/me/plan. Having no plan yet is not an error but the entrance to the first interview. */
export const planResponseSchema = z
  .object({
    plan: studyPlanSchema.nullable(),
  })
  .strict();
export type PlanResponse = z.infer<typeof planResponseSchema>;
