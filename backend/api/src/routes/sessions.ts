import {
  type CreateSessionRequest,
  type CreateSessionResponse,
  type SessionMetadata,
  type SessionProblem,
  type StartSessionResponse,
  type UpdateSessionTopicsResponse,
  createSessionRequestSchema,
  sessionMetadataSchema,
  sessionPhotoParts,
  startSessionRequestSchema,
  updateSessionTopicsRequestSchema,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import {
  type AllowedTopics,
  allowedTopicList,
  allowedTopicsLocale,
  buildAllowedTopics,
  toLocalDate,
} from "@ai-sensei/guardrail";
import {
  formatAllowedTopics,
  formatBullets,
  formatProblemText,
  formatVisibleWork,
} from "@ai-sensei/prompts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Bindings } from "../env.ts";
import { readLimits } from "../env.ts";
import {
  analysesPerDay,
  canReissueToken,
  canStartSessionToday,
  hasPremiumAccess,
  limitReachedAllowance,
  sessionMaxSeconds,
  sessionsPerDay,
  startedAllowance,
  tokenGraceSeconds,
} from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import { type AgentDispatch, createLiveKitToken } from "../lib/livekit.ts";
import {
  type PhotoAnalysis,
  type PhotoAnalysisImage,
  detectImageMediaType,
  resolveDetectedTopics,
  resolveSessionProblem,
  toDetectedTopicPayload,
} from "../lib/photo-analysis.ts";
import type { HoleRecord, SessionContext } from "../repository/types.ts";

export const sessionsRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions
 *
 * Takes the photos, decides the unit with a Vision LLM, and returns only the
 * unit and a read-back of the problem text. The allow-listed topics built here
 * become the baseline for the in-conversation guardrails.
 *
 * Today's single use is NOT counted here. It is counted when the conversation
 * starts (`POST /v1/sessions/{id}/start`). This fixes the case where taking a
 * photo and confirming the unit consumed the slot, leaving "that's it for today"
 * without ever talking to the senpai.
 *
 * Instead of counting, this entrance has two gates:
 *
 *   1. has today's lesson already been used up (the pre-check below)? Running a
 *      Vision LLM and only then refusing costs both money and goodwill
 *   2. a cap on analyses themselves (`analysesPerDay`), far looser than the
 *      daily lesson count, stopping only endless analyse-only usage
 */
sessionsRoute.post("/", async (c) => {
  const { repository, analyzer, now, newId } = c.get("services");
  const log = c.get("log");
  const deviceId = c.get("deviceId");
  const at = now();
  const limits = readLimits(c.env);

  const form = await c.req.formData();
  const meta = parseMeta(form.get("meta"));
  /** The app's display language. Error messages come back in it. */
  const locale = meta.locale;

  const user = await repository.ensureUser(deviceId, at);
  /**
   * Fact: toLocalDate defaults to fixed JST (+540 min) and is built by the server
   * from the receive time, not from the client's claim. Two requests arriving at
   * the same instant always get the same local_date, so the cap's key never
   * wobbles per request.
   *
   * Judgement: the only drift is the few milliseconds around the JST date
   * boundary, and those two really do belong to different days. Conversely, the
   * moment local_date came from a client claim, shifting the date by one would
   * grow a fresh slot and the cap would be useless.
   *
   * To follow the user's timezone in future, assume the server still decides the
   * offset, and move countStartedSessionsOnDate's display and the slot check to
   * the same date rule together.
   */
  const localDate = toLocalDate(at);

  // Free covers only the 10-second quiz in `/v1/me/reviews`. Past that we spin up
  // LiveKit, STT, LLM and TTS to reteach with a board, so the normal Premium
  // boundary applies. Blocking in the UI alone is bypassable by posting `hole_id`
  // directly, so the check is server-side. Metered cost starts at `/start`, which
  // checks too - this is the early gate that refuses before starting.
  if (meta.kind === "review" && !hasPremiumAccess({ user, now: at, limits })) {
    throw apiError("premium_required", { locale });
  }

  // Review sessions use no photo; the unit comes from the target hole.
  // Ownership is verified here so someone else's hole id does nothing.
  let reviewHole: HoleRecord | null = null;
  if (meta.kind === "review") {
    reviewHole = meta.hole_id ? await repository.getHole(meta.hole_id) : null;
    if (!reviewHole || reviewHole.device_id !== deviceId) {
      throw apiError("session_not_found", { locale });
    }
  }

  /**
   * Stop anyone who cannot start a lesson today before reading the photo.
   *
   * This is not a slot reservation (that is a single operation in `/start`).
   * Counting here and again at start means another session can slip in between,
   * and that is fine: the gap only causes "analysed but cannot start", while the
   * cap itself is enforced by `/start`. Removing this would run a Vision LLM for
   * everyone who is used up, and only then refuse.
   */
  const startedToday = await repository.countStartedSessionsOnDate(deviceId, localDate);
  if (!canStartSessionToday({ user, sessionsToday: startedToday, now: at, limits })) {
    const limitReached = limitReachedAllowance({ user, now: at, limits });
    throw apiError(limitReached.reason, {
      locale,
      retryAfterSeconds: limitReached.retryAfterSeconds,
    });
  }

  const photo = form.get(sessionPhotoParts.notes);
  /**
   * The problem photo. This is a textbook or workbook page - someone else's
   * copyrighted work - so it never goes into R2.
   */
  const problemPhoto = form.get(sessionPhotoParts.problem);

  /**
   * `kind: "new"` needs only one of the two. Reject only when both are missing.
   *
   * Back when notes were mandatory, this line broke the discard promise: a student
   * with no notes had no route but to put the printed page in the `photo` slot, so
   * someone else's copyrighted work ended up stored in R2 (full reasoning in
   * `contract`'s `sessionPhotoParts`).
   */
  if (meta.kind === "new" && !(photo instanceof File) && !(problemPhoto instanceof File)) {
    throw apiError("photo_unreadable", { locale });
  }

  const sessionId = newId("ses");

  // A conditional INSERT checks the cap and creates the row in one operation, so
  // concurrent posts cannot take the same slot. What is claimed here is the
  // *analysis* slot (the lesson slot is `/start`). It is claimed before the photo
  // upload and analysis, and released below by deleting the row if analysis fails.
  const created = await repository.createSession({
    session: {
      id: sessionId,
      device_id: deviceId,
      kind: meta.kind,
      status: "open",
      created_at: at.toISOString(),
      completed_at: null,
      local_date: localDate,
      photo_key: null,
      topic_ids: [],
      hole_id: reviewHole?.id ?? null,
      duration_seconds: null,
      context: null,
      // The conversation has not started. While this is null the row does not count as a use.
      started_at: null,
    },
    maxAnalysesPerDay: analysesPerDay({ user, now: at, limits }),
  });
  if (!created) {
    // The analysis cap, not the lesson cap. Only abusive usage reaches here, so the
    // wording matches the daily cap (both avoid numbers and just say "that's it for
    // today") rather than adding an app branch for a cap ordinary students never see.
    const limitReached = limitReachedAllowance({ user, now: at, limits });
    log?.warn("analysis_limit_reached", { kind: meta.kind, local_date: localDate });
    throw apiError(limitReached.reason, {
      locale,
      retryAfterSeconds: limitReached.retryAfterSeconds,
    });
  }
  /**
   * The conversation's language. Not the app's display language - it follows the
   * curriculum of the unit being handled.
   *
   * Reviews start from a hole, so the hole's curriculum is the conversation
   * language. Switching the device to English and asking about a hole recorded in
   * Japanese would not work: the hole description and unit name stay Japanese, so
   * the conversation would not line up.
   */
  const conversationLocale = reviewHole ? (localeOfTopicId(reviewHole.topic_id) ?? locale) : locale;

  let topicIds: string[] = reviewHole ? [reviewHole.topic_id] : [];
  let photoKey: string | null = null;
  let summary = reviewHole ? reviewSummary(conversationLocale, reviewHole.desc) : "";
  let visibleWork: string[] = [];
  let questionSeeds: string[] = reviewHole ? [reviewHole.desc] : [];
  let analysis: PhotoAnalysis | null = null;
  let problem: SessionProblem | null = null;

  let allowed: AllowedTopics;
  try {
    if (photo instanceof File || problemPhoto instanceof File) {
      /**
       * The two photos are read independently. If one is unreadable, the other
       * still lets us proceed. The format is decided from the content, not the
       * client's claim (sending something undecidable to the Vision API only
       * returns a 400).
       *
       * Returning 422 because one is unreadable would make a supposedly optional
       * photo effectively required. Below we look only at whether *zero* photos
       * were readable, not at how many failed.
       */
      let notesImage: PhotoAnalysisImage | undefined;
      if (photo instanceof File) {
        const image = await photo.arrayBuffer();
        const mediaType = detectImageMediaType(image, photo.type);
        if (mediaType) {
          notesImage = { image, contentType: mediaType };
          // Notes are the student's own work, so they are stored.
          photoKey = `photos/${deviceId}/${sessionId}`;
          await c.env.PHOTOS.put(photoKey, image, {
            httpMetadata: { contentType: mediaType },
          });
        } else {
          log?.warn("notes_photo_unreadable", { session_id: sessionId });
        }
      }

      /**
       * The problem photo. There is no `PHOTOS.put` here, and that is the point.
       *
       * Textbook and workbook pages are someone else's copyrighted work, so they are
       * sent for analysis but never stored (settling plan §4-1 / §10-4 as
       * "discard after analysis"). Once analysis finishes, `problemImage` is
       * unreferenced and simply dropped.
       */
      let problemImage: PhotoAnalysisImage | undefined;
      if (problemPhoto instanceof File) {
        const bytes = await problemPhoto.arrayBuffer();
        const problemMediaType = detectImageMediaType(bytes, problemPhoto.type);
        if (problemMediaType) {
          problemImage = { image: bytes, contentType: problemMediaType };
        } else {
          log?.warn("problem_photo_unreadable", { session_id: sessionId });
        }
      }

      // If no readable photo is left, return "could not read it" here. Calling the
      // analyser with no image sometimes answers with an imagined unit.
      const images = notesImage
        ? { notes: notesImage, problem: problemImage }
        : problemImage
          ? { problem: problemImage }
          : null;
      if (!images) throw apiError("photo_unreadable", { locale });

      analysis = await analyzer.analyze({
        ...images,
        locale: conversationLocale,
        stage: meta.school_stage,
      });
      // Unsupported subjects and non-notes photos stop here. The point is judging
      // "out of scope", not "not math" - this line does not change as subjects are
      // added.
      if (analysis.subject === "other") {
        throw apiError("out_of_scope", { locale });
      }

      const resolved = resolveDetectedTopics(analysis, conversationLocale, meta.school_stage);
      topicIds = resolved.topicIds;
      summary = analysis.summary;
      visibleWork = analysis.visible_work;
      questionSeeds = analysis.question_seeds;

      const resolvedProblem = resolveSessionProblem({
        analysis,
        hadProblemPhoto: problemImage !== undefined,
      });
      problem = resolvedProblem.problem;

      // Whether §0 decision 4 ("send the problem and the notes together") actually
      // works is only observable here. Mostly not_found means §4-1's hint is weak;
      // too_long means the analysis prompt is not landing.
      log?.info("problem_resolved", {
        session_id: sessionId,
        outcome: resolvedProblem.outcome,
        source: problem?.source ?? null,
        // The page is not stored. The only trace kept is the fact that it was sent.
        problem_photo: problemPhoto instanceof File ? "analyzed_and_discarded" : "absent",
        // How often "no notes" becomes the normal path is only observable here. If
        // most land here, "I can't even start" was the central request.
        notes_photo: notesImage ? "stored" : "absent",
      });
    }

    // If the user corrected the unit in the chip UI, prefer that
    if (meta.topic_ids && meta.topic_ids.length > 0) {
      topicIds = meta.topic_ids;
    }

    allowed = buildAllowedTopics(topicIds);
    if (allowed.primary.size === 0) {
      throw apiError("photo_unreadable", { locale });
    }
  } catch (error) {
    // Release the claimed slot. An unreadable photo must not cost today's lesson.
    await repository.deleteSession(sessionId);

    // "Photo unreadable" is expected (the user gets a message). A Vision API outage
    // or an expired key is not, and until it is fixed nobody can start.
    if (error instanceof HTTPException) {
      log?.warn("session_rejected", { session_id: sessionId, status: error.status });
    } else {
      log?.error("photo_analysis_failed", error, { session_id: sessionId, kind: meta.kind });
    }
    throw error;
  }

  // Keep the analysis result on the session so narrowing the unit (PATCH /topics)
  // does not re-analyse the photo.
  const context: SessionContext = {
    summary,
    // The photo is not kept, so this is the only home for the problem text (see the SessionContext comment).
    problem,
    visible_work: visibleWork,
    question_seeds: questionSeeds,
    topics: analysis?.topics ?? [],
  };

  await repository.updateSessionTopics({
    sessionId,
    topicIds: [...allowed.primary],
    photoKey,
    context,
  });

  // How many analysed sessions actually reach a conversation (= `session_started`)
  // is visible only in the gap between these two lines. How many take a photo and
  // quit feeds back into the confirmation screen's design.
  log?.info("session_created", {
    session_id: sessionId,
    kind: meta.kind,
    locale: conversationLocale,
    topic_ids: [...allowed.primary],
  });

  const response: CreateSessionResponse = {
    session_id: sessionId,
    kind: meta.kind,
    detected_topics: buildDetectedTopics(allowed, context),
    problem,
  };

  return c.json(response, 201);
});

/**
 * POST /v1/sessions/{id}/start
 *
 * Starts the conversation. The only place today's single use is counted.
 *
 * The point is that claiming the slot and issuing the token are one operation,
 * in an order that cannot be swapped (no slot means no token; a token means the
 * slot was taken). Back when the token was handed out at analysis time, holding
 * the key meant being able to start at any time - so "count at conversation
 * start" put the counter on the client.
 *
 * No photo is analysed again. The unit and problem text are already on the
 * session, so all that happens here is claiming the slot and putting that
 * context back on a token.
 */
sessionsRoute.post("/:sessionId/start", async (c) => {
  const { repository, now } = c.get("services");
  const log = c.get("log");
  const deviceId = c.get("deviceId");
  const at = now();
  const limits = readLimits(c.env);

  // The body only carries the error-message language. It is optional (the unit decides the conversation language).
  const parsed = startSessionRequestSchema.safeParse(await c.req.json().catch(() => null));
  const locale = parsed.success ? parsed.data.locale : "ja";

  const sessionId = c.req.param("sessionId");
  const session = await repository.getSession(sessionId);
  // Other people's sessions and finished sessions are untouchable.
  if (!session || session.device_id !== deviceId || session.status !== "open") {
    throw apiError("session_not_found", { locale });
  }

  // A session with no unit decided by analysis leaves the guardrail baseline empty.
  const allowed = buildAllowedTopics(session.topic_ids);
  if (allowed.primary.size === 0) throw apiError("photo_unreadable", { locale });

  const user = await repository.ensureUser(deviceId, at);
  // The entitlement is checked at creation too, but it can expire in between.
  // Metered cost starts at this entrance, so check again.
  if (session.kind === "review" && !hasPremiumAccess({ user, now: at, limits })) {
    throw apiError("premium_required", { locale });
  }

  /**
   * Pressing again can reissue a token only while the first key is still alive
   * (reasoning in {@link canReissueToken}).
   *
   * Without this, a session opened but never joined becomes a voucher for a key
   * with no expiry. Without a conversation `/complete` never arrives, so the row
   * stays open, and pressing that id tomorrow would add a lesson without spending
   * today's slot.
   */
  if (
    session.started_at !== null &&
    !canReissueToken({
      startedAt: session.started_at,
      now: at,
      maxSeconds: sessionMaxSeconds({ user, now: at, limits }),
    })
  ) {
    // "There is no room to enter any more" looks the same to the app as a deleted
    // session. End with 404 so the retry path stops looping on the same id.
    log?.info("session_start_expired", {
      session_id: session.id,
      started_at: session.started_at,
    });
    throw apiError("session_not_found", { locale });
  }

  /**
   * The hole to reteach in a review. Re-read from the source of truth on every
   * token issue.
   *
   * Reconstructing it from `context.summary` is rejected: that is formatted for
   * display and, above all, loses the student's own `evidence` (same reason as
   * PATCH /topics).
   */
  const reviewHole =
    session.kind === "review" && session.hole_id !== null
      ? await repository.getHole(session.hole_id)
      : null;
  if (session.kind === "review" && (!reviewHole || reviewHole.device_id !== deviceId)) {
    throw apiError("session_not_found", { locale });
  }

  const started = await repository.startSession({
    sessionId: session.id,
    deviceId,
    startedAt: at.toISOString(),
    // The day counted is the day it *started*, not the day of the photo. A conversation started across midnight is today's.
    localDate: toLocalDate(at),
    maxPerDay: sessionsPerDay({ user, now: at, limits }),
  });
  if (!started.started) {
    const limitReached = limitReachedAllowance({ user, now: at, limits });
    throw apiError(limitReached.reason, {
      locale,
      retryAfterSeconds: limitReached.retryAfterSeconds,
    });
  }
  const allowance = startedAllowance({
    user,
    sessionsToday: started.sessionsToday,
    now: at,
    limits,
  });

  const context: SessionContext = session.context ?? {
    summary: "",
    problem: null,
    visible_work: [],
    question_seeds: [],
    topics: [],
  };

  // Context handed to the agent. The in-conversation guardrails use it as the baseline.
  const metadata = buildSessionMetadata({
    sessionId: session.id,
    // The conversation language follows the unit's curriculum (not the device language).
    locale: allowedTopicsLocale(allowed),
    kind: session.kind,
    maxSeconds: allowance.maxSeconds,
    context,
    allowed,
    isPremium: user.is_premium,
    // Photos are not re-analysed, so a stored key is exactly "were there notes".
    hasNotesPhoto: session.photo_key !== null,
    reviewHole,
  });

  const dispatch = agentDispatch(c.env, metadata);
  const token = await createLiveKitToken({
    apiKey: c.env.LIVEKIT_API_KEY,
    apiSecret: c.env.LIVEKIT_API_SECRET,
    identity: deviceId,
    room: session.id,
    // The same length as the reissue window. Extending only one gives either "the
    // key is alive but cannot be reissued" or the reverse.
    ttlSeconds: allowance.maxSeconds + tokenGraceSeconds,
    metadata,
    agent: dispatch,
    now: at,
  });

  // Reports of "the conversation never starts" are traced from here. We need to
  // know whether the room was created and how the agent was called (explicit or auto).
  log?.info("session_started", {
    session_id: session.id,
    kind: session.kind,
    locale: allowedTopicsLocale(allowed),
    topic_ids: [...allowed.primary],
    max_seconds: allowance.maxSeconds,
    agent_dispatch: dispatch ? "explicit" : "automatic",
    // A retry/reconnect that only reissued a token. The slot was not counted again.
    replayed: started.alreadyStarted,
  });

  const response: StartSessionResponse = {
    session_id: session.id,
    kind: session.kind,
    livekit: { url: c.env.LIVEKIT_URL, token, room: session.id },
    limits: {
      max_seconds: allowance.maxSeconds,
      lesson_allowed_today: allowance.lessonAllowedToday,
    },
  };

  return c.json(response, 200);
});

/**
 * PATCH /v1/sessions/{id}/topics
 *
 * Applies units removed in the chip UI. The session is not recreated.
 *
 * This used to call POST /v1/sessions again, so photographing and confirming the
 * unit spent the free daily allowance (once a day) twice, and the moment the
 * conversation started the user was told "that's it for today". It also pushed
 * the same photo through the Vision LLM twice, so the same row is rewritten even
 * when the unit changes.
 *
 * No token is issued here either. The room key comes only from `/start`, which
 * builds the context from the session as it stands then (i.e. after narrowing).
 */
sessionsRoute.patch("/:sessionId/topics", async (c) => {
  const { repository } = c.get("services");
  const deviceId = c.get("deviceId");

  const parsed = updateSessionTopicsRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw apiError("photo_unreadable");
  const { locale, topic_ids: requested } = parsed.data;

  const sessionId = c.req.param("sessionId");
  const session = await repository.getSession(sessionId);
  // Other people's sessions and finished sessions are untouchable.
  if (!session || session.device_id !== deviceId || session.status !== "open") {
    throw apiError("session_not_found", { locale });
  }

  // Only units detected by the analysis may be chosen. Opening this up would let
  // someone swap in a unit unrelated to the photo and bypass the guardrails.
  const detected = new Set(session.topic_ids);
  const allowed = buildAllowedTopics(requested.filter((topicId) => detected.has(topicId)));
  if (allowed.primary.size === 0) throw apiError("photo_unreadable", { locale });

  const context: SessionContext = session.context ?? {
    summary: "",
    problem: null,
    visible_work: [],
    question_seeds: [],
    topics: [],
  };

  await repository.updateSessionTopics({
    sessionId,
    topicIds: [...allowed.primary],
    photoKey: session.photo_key,
    context,
  });

  const response: UpdateSessionTopicsResponse = {
    session_id: sessionId,
    kind: session.kind,
    detected_topics: buildDetectedTopics(allowed, context),
    // The photo is not re-analysed; the problem text stored on the session is returned as-is.
    problem: context.problem ?? null,
  };

  return c.json(response, 200);
});

/**
 * How the agent is called into this room.
 *
 * When the worker runs with a name (LiveKit Cloud agent hosting sets
 * `LIVEKIT_AGENT_NAME` automatically), auto dispatch does not fire. Put it on the
 * token so the agent is called the moment the room is created. Leave this empty
 * and the app enters the room, nobody arrives, and it sits on "listening" until
 * the time cap.
 *
 * If the worker runs unnamed (auto dispatch), leaving it unset is fine.
 */
function agentDispatch(env: Bindings, metadata: string): AgentDispatch | undefined {
  const name = env.LIVEKIT_AGENT_NAME?.trim();
  if (!name) return undefined;
  // Pass the same content as participant metadata to the job too, so an agent
  // dispatched first can read the context without waiting for the participant.
  return { name, metadata };
}

/**
 * "Today's notes" for a review session. There is no photo, so the previous hole
 * is the context. It is pasted into the prompt, so write it in the conversation's
 * language.
 */
function reviewSummary(locale: "ja" | "en", desc: string): string {
  return locale === "en" ? `Last time, ${desc}` : `前回、${desc}`;
}

/**
 * The value passed to the prompt as what is written in the notes.
 *
 * It holds no wording of its own. {@link formatVisibleWork} in `@ai-sensei/prompts`
 * is the single home (`prompts/senpai_*.md` names those strings), and all this
 * decides is whether to pass `null`. Same reason as for `problem_text`: two fill
 * sites mean the wording changes by route, so the API does not rebuild it.
 *
 * `null` (= no notes photo) applies only to `kind: "new"`. Review sessions use no
 * photo at all and take the previous hole as context, so saying "no notes photo"
 * there reports an absence that does not exist.
 *
 * Notes that were sent but unreadable also count as `null`. To the senpai, "never
 * taken" and "unreadable" both mean zero clues, and claiming "(none)" = taken but
 * blank would be further from the truth.
 */
function studentWorkForPrompt(input: {
  locale: "ja" | "en";
  kind: "new" | "review";
  visibleWork: readonly string[];
  hasNotesPhoto: boolean;
}): string {
  const noNotesPhoto = input.kind === "new" && !input.hasNotesPhoto;
  return formatVisibleWork(noNotesPhoto ? null : input.visibleWork, input.locale);
}

/**
 * The conversation context the agent reads from the token. Shaped as `contract`'s
 * {@link SessionMetadata}.
 *
 * Type-checked as `SessionMetadata` and validated at runtime against the shared
 * schema before stringifying. This being a bare object literal is why nobody
 * noticed the missing `problem_text` field, and the agent reused `photo_summary`
 * (a "what is in the picture" summary) as the problem text - the senpai was
 * teaching without seeing the problem itself (plan §0 decision 4, unimplemented).
 * Types vanish at runtime, so without validation a broken envelope rides the token.
 */
function buildSessionMetadata(input: {
  sessionId: string;
  locale: "ja" | "en";
  kind: "new" | "review";
  maxSeconds: number;
  context: SessionContext;
  allowed: AllowedTopics;
  isPremium: boolean;
  /** Whether the notes photo is in R2 (= was sent). Changes `student_work`'s wording. */
  hasNotesPhoto: boolean;
  /** The single hole being retaught in a review. `null` for new lessons. */
  reviewHole: HoleRecord | null;
}): string {
  const metadata = sessionMetadataSchema.parse({
    session_id: input.sessionId,
    locale: input.locale,
    kind: input.kind,
    max_seconds: input.maxSeconds,
    photo_summary: input.context.summary,
    // Formatted fragments are pasted straight into the prompt. Match the
    // conversation's language, placeholders for empty values included.
    // No wording lives here. As with `formatVisibleWork`, the strings the prompt
    // names by hand are collected in `@ai-sensei/prompts`. All this decides is
    // "was it readable" (i.e. whether to pass `null`).
    problem_text: formatProblemText(input.context.problem?.text ?? null, input.locale),
    visible_work: studentWorkForPrompt({
      locale: input.locale,
      kind: input.kind,
      visibleWork: input.context.visible_work,
      hasNotesPhoto: input.hasNotesPhoto,
    }),
    question_seeds: formatBullets(input.context.question_seeds, input.locale),
    allowed_topics: formatAllowedTopics(allowedTopicList(input.allowed), input.locale),
    allowed_topic_ids: [...input.allowed.primary, ...input.allowed.prerequisite],
    is_premium: input.isPremium,
    // The whole previous karte is not included. Passing out-of-scope holes and
    // "what they got right" to the board LLM widens a one-hole review into a
    // re-lecture of the entire previous session. The target hole's description and
    // the student's own words behind it are enough to locate what to reteach.
    review_hole:
      input.reviewHole === null
        ? null
        : {
            topic_id: input.reviewHole.topic_id,
            desc: input.reviewHole.desc,
            evidence: input.reviewHole.evidence,
          },
  } satisfies SessionMetadata);
  return JSON.stringify(metadata);
}

/**
 * Units shown in the chip UI.
 * The analyser's confidence is passed through. Dropping it here would push even
 * high-confidence candidates to the fallback (0.4), so every chip would render
 * as "candidate".
 */
function buildDetectedTopics(allowed: AllowedTopics, context: SessionContext) {
  return toDetectedTopicPayload([...allowed.primary], {
    subject: "math",
    summary: context.summary,
    problem_text: context.problem?.text ?? "",
    visible_work: context.visible_work,
    topics: context.topics,
    unreadable: [],
    question_seeds: context.question_seeds,
  });
}

// The return type is the contract type itself. Rebuilding it by hand quietly
// creates a state where an added field passes the schema but is invisible from the server.
function parseMeta(value: File | string | null): CreateSessionRequest {
  if (typeof value !== "string" || value.length === 0) {
    // A missing meta part means an old app. Return the schema's defaults.
    return createSessionRequestSchema.parse({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw apiError("photo_unreadable");
  }
  const parsed = createSessionRequestSchema.safeParse(raw);
  if (!parsed.success) throw apiError("photo_unreadable");
  return parsed.data;
}
