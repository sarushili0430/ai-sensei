import {
  type CompleteSessionResponse,
  type Hole,
  completeSessionRequestSchema,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import {
  buildAllowedTopics,
  computeProgress,
  filterHoleTopicIds,
  scheduleReviews,
  toLocalDate,
} from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv, Limits } from "../env.ts";
import { readLimits } from "../env.ts";
import { hasPremiumAccess, shouldShowPaywall } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import type {
  HoleRecord,
  KarteRecord,
  Repository,
  ReviewScheduleRecord,
  SessionRecord,
} from "../repository/types.ts";

export const completeRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions/{id}/complete - the internal endpoint the agent calls.
 *
 * Takes the transcript and the karte draft, then:
 *   1. matches the holes' topic_ids against this session's allow-list (guardrail 2)
 *   2. saves the karte and holes to D1
 *   3. books review pushes for +1/+3/+7 days with OneSignal
 *   4. marks the target hole "filled" when the student self-reported "I said it"
 *      in a review session
 */
completeRoute.post("/:sessionId/complete", async (c) => {
  const { repository, scheduler, now, newId } = c.get("services");
  const log = c.get("log");
  const at = now();

  const authorized = c.req.header("authorization") === `Bearer ${c.env.INTERNAL_API_TOKEN}`;
  if (!authorized) {
    // A mismatched internal token between agent and API drops only the karte while
    // the conversation succeeds. The app just shows "no karte", so log it here.
    log?.warn("complete_unauthorized", { session_id: c.req.param("sessionId") });
    throw apiError("unauthorized");
  }

  const session = await repository.getSession(c.req.param("sessionId"));
  if (!session) throw apiError("session_not_found");

  // The agent sometimes resends after a timeout. Passing it through would create
  // duplicate kartes, holes and notification bookings, so return what already exists.
  const existing = await repository.getKarteBySession(session.id);
  if (existing) {
    log?.info("complete_replayed", { session_id: session.id });
    return c.json(
      await buildResponse({ repository, at, session, stored: existing, limits: readLimits(c.env) }),
      200,
    );
  }

  const parsed = completeSessionRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    // The karte contract is broken - either the agent's LLM output or schema drift.
    log?.error("complete_invalid_payload", parsed.error, { session_id: session.id });
    return c.json({ error: { code: "internal_error", message: parsed.error.message } }, 400);
  }
  const body = parsed.data;

  const durationSeconds = Math.min(body.duration_seconds, 60 * 60);
  await repository.completeSession({
    sessionId: session.id,
    completedAt: at.toISOString(),
    durationSeconds,
  });

  // Tags that went outside the allowed scope during the conversation are fixed
  // here. Off-target tags make review notifications off-target too, but the hole
  // itself is never dropped: what is off is the id the LLM attached, not the fact
  // that the student got stuck. Dropping it empties the karte and the screen reads
  // "explained without stalling".
  const allowed = buildAllowedTopics(session.topic_ids);
  const { rejected } = filterHoleTopicIds(body.karte.holes, allowed);
  const misTagged = new Set(rejected.map((entry) => entry.hole));
  const fallbackTopicId = session.topic_ids[0];
  if (rejected.length > 0) {
    log?.warn("guardrail_retagged_holes", {
      session_id: session.id,
      retagged_to: fallbackTopicId ?? null,
      dropped: rejected.map((entry) => ({
        topic_id: entry.hole.topic_id,
        reason: entry.reason,
      })),
    });
  }
  const acceptedHoles = body.karte.holes.flatMap((hole) => {
    if (!misTagged.has(hole)) return [hole];
    // Only sessions with nowhere to remap are dropped.
    return fallbackTopicId === undefined ? [] : [{ ...hole, topic_id: fallbackTopicId }];
  });

  const karteId = newId("kar");
  const holeRecords: HoleRecord[] = acceptedHoles.map((hole) => ({
    id: newId("hol"),
    device_id: session.device_id,
    karte_id: karteId,
    topic_id: hole.topic_id,
    desc: hole.desc,
    severity: hole.severity,
    evidence: hole.evidence ?? null,
    quiz: hole.quiz ?? null,
    status: "open",
    created_at: at.toISOString(),
    filled_at: null,
  }));

  const user = await repository.getUser(session.device_id);
  const premium = hasPremiumAccess({ user, now: at, limits: readLimits(c.env) });

  const karteRecord: KarteRecord = {
    id: karteId,
    session_id: session.id,
    device_id: session.device_id,
    created_at: at.toISOString(),
    topic_ids: session.topic_ids,
    said_well: body.karte.said_well,
    term_notes: body.karte.term_notes,
    // Follow-up questions are Premium. Not even stored for free users.
    followup_question: premium ? (body.karte.followup_question ?? null) : null,
  };
  await repository.insertKarte(karteRecord, holeRecords);

  // Review holes are filled only when the student self-reports "I said it", never
  // by AI grading. Auto-filling on a session that merely connected would take the
  // decision about whether they explained it away from them.
  let filledThisSession = 0;
  if (session.kind === "review" && session.hole_id && body.review_outcome === "said_it") {
    const target = await repository.getHole(session.hole_id);
    // Cross-check the session's owner so someone else's hole is never filled
    if (target && target.device_id === session.device_id && target.status === "open") {
      await repository.markHoleFilled(target.id, at.toISOString());
      filledThisSession += 1;
      const cancelled = await repository.cancelReviewSchedules(target.id);
      for (const entry of cancelled) {
        if (entry.external_id) await scheduler.cancel(entry.external_id);
      }
    }
  }

  const scheduleEntries = scheduleReviews(
    holeRecords.map((hole) => hole.id),
    at,
  );
  const persisted: ReviewScheduleRecord[] = [];
  for (const entry of scheduleEntries) {
    const hole = holeRecords.find((candidate) => candidate.id === entry.hole_id);
    if (!hole) continue;
    let externalId: string | null = null;
    try {
      const scheduled = await scheduler.schedule({
        deviceId: session.device_id,
        holeId: hole.id,
        step: entry.step,
        sendAt: entry.scheduled_at,
        desc: hole.desc,
        daysSince: entry.step === 1 ? 1 : entry.step === 2 ? 3 : 7,
        // The notification language comes from the hole's topic_id. The karte is
        // written in that curriculum's language, so this - not the device setting -
        // is authoritative.
        locale: localeOfTopicId(hole.topic_id),
      });
      externalId = scheduled.externalId;
    } catch (error) {
      // Return the karte even if booking the notification failed. Do not stop the
      // experience for a push.
      log?.error("review_schedule_failed", error, { session_id: session.id, hole_id: hole.id });
    }
    persisted.push({
      id: newId("rev"),
      hole_id: hole.id,
      step: entry.step,
      scheduled_at: entry.scheduled_at,
      external_id: externalId,
    });
  }
  await repository.insertReviewSchedules(persisted);

  const sessionDates = await repository.sessionDates(session.device_id);
  const allHoles = await repository.listHoles(session.device_id);
  const progress = computeProgress(sessionDates, allHoles, toLocalDate(at));

  const response: CompleteSessionResponse = {
    karte: {
      id: karteRecord.id,
      session_id: karteRecord.session_id,
      created_at: karteRecord.created_at,
      topic_ids: karteRecord.topic_ids,
      said_well: karteRecord.said_well,
      holes: holeRecords.map(toHolePayload),
      term_notes: karteRecord.term_notes,
      followup_question: karteRecord.followup_question,
    },
    review_schedule: persisted.map((entry) => ({
      hole_id: entry.hole_id,
      step: entry.step,
      scheduled_at: entry.scheduled_at,
    })),
    progress,
    show_paywall: shouldShowPaywall({
      isPremium: premium,
      // Counted by days with a karte, not by session count, so repeating on the
      // same day still shows the paywall only once.
      completedSessionCount: sessionDates.length,
      holesFound: holeRecords.length,
    }),
  };

  // Whether a conversation happened is visible from this one line (zero holes is not a failure).
  log?.info("karte_stored", {
    session_id: session.id,
    kind: session.kind,
    ended_reason: body.ended_reason,
    review_outcome: body.review_outcome ?? null,
    duration_seconds: durationSeconds,
    transcript_turns: body.transcript.length,
    holes: holeRecords.length,
    dropped_holes: rejected.length,
    filled_holes: filledThisSession,
  });

  return c.json(response, 201);
});

function toHolePayload(hole: HoleRecord): Hole {
  return {
    id: hole.id,
    topic_id: hole.topic_id,
    desc: hole.desc,
    severity: hole.severity,
    ...(hole.evidence ? { evidence: hole.evidence } : {}),
    ...(hole.quiz ? { quiz: hole.quiz } : {}),
    status: hole.status,
    created_at: hole.created_at,
    filled_at: hole.filled_at,
  };
}

/**
 * Rebuilds the response from a stored karte.
 *
 * Used both by:
 * - the agent's resend (/complete called twice)
 * - the app's result fetch (GET /v1/sessions/{id}/result)
 *
 * The karte takes a few seconds after the conversation ends, so the app polls
 * this endpoint after completion.
 */
export async function buildResponse(input: {
  repository: Repository;
  at: Date;
  session: SessionRecord;
  stored: { karte: KarteRecord; holes: HoleRecord[] };
  limits: Limits;
}): Promise<CompleteSessionResponse> {
  const { repository, at, session, stored, limits } = input;

  const [sessionDates, allHoles, user] = await Promise.all([
    repository.sessionDates(session.device_id),
    repository.listHoles(session.device_id),
    repository.getUser(session.device_id),
  ]);

  return {
    karte: {
      id: stored.karte.id,
      session_id: stored.karte.session_id,
      created_at: stored.karte.created_at,
      topic_ids: stored.karte.topic_ids,
      said_well: stored.karte.said_well,
      holes: stored.holes.map(toHolePayload),
      term_notes: stored.karte.term_notes,
      followup_question: stored.karte.followup_question,
    },
    review_schedule: [],
    progress: computeProgress(sessionDates, allHoles, toLocalDate(at)),
    show_paywall: shouldShowPaywall({
      isPremium: hasPremiumAccess({ user, now: at, limits }),
      completedSessionCount: sessionDates.length,
      holesFound: stored.holes.length,
    }),
  };
}

/**
 * GET /v1/sessions/{id}/result - the app fetches the result after a conversation.
 * Returns 202 while the karte is not ready; the app waits and asks again.
 */
completeRoute.get("/:sessionId/result", async (c) => {
  const { repository, now } = c.get("services");
  const deviceId = c.get("deviceId");
  const at = now();

  const session = await repository.getSession(c.req.param("sessionId"));
  if (!session || session.device_id !== deviceId) throw apiError("session_not_found");

  const stored = await repository.getKarteBySession(session.id);
  if (!stored) {
    // Karte generation in progress. The app treats this as "not yet" and retries shortly.
    return c.json({ status: "pending" }, 202);
  }

  return c.json(
    await buildResponse({ repository, at, session, stored, limits: readLimits(c.env) }),
    200,
  );
});
