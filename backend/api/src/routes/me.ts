import {
  type Hole,
  type ParentReportResponse,
  type ProgressResponse,
  type ReviewAnswerResponse,
  type ReviewQueueResponse,
  filledHolesLimit,
  parentReportQuoteMaxCount,
  parentReportQuoteMaxLength,
  parentReportTopicMaxCount,
  reviewAnswerRequestSchema,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import {
  buildReviewPrompt,
  computeParentReport,
  computeProgress,
  currentMonthPeriod,
  daysBetween,
  toLocalDate,
} from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { readLimits } from "../env.ts";
import { canStartSessionToday, hasPremiumAccess } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import type { HoleRecord } from "../repository/types.ts";

export const meRoute = new Hono<AppEnv>();

/** GET /v1/me/progress - the home screen's counters. */
meRoute.get("/progress", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");
  const limits = readLimits(c.env);

  const user = await repository.ensureUser(deviceId, at);
  const premium = hasPremiumAccess({ user, now: at, limits });
  const localDate = toLocalDate(at);

  const [sessionDates, holes, sessionsToday] = await Promise.all([
    repository.sessionDates(deviceId),
    repository.listHoles(deviceId),
    // Only sessions that started a conversation are counted. A session that just
    // took a photo and confirmed the unit must not close the home flow.
    repository.countStartedSessionsOnDate(deviceId, localDate),
  ]);

  const response: ProgressResponse = {
    progress: computeProgress(sessionDates, holes, localDate),
    is_premium: premium,
    limits: {
      max_seconds: premium ? limits.premiumSessionMaxSeconds : limits.freeSessionMaxSeconds,
      lesson_allowed_today: canStartSessionToday({ user, sessionsToday, now: at, limits }),
    },
  };
  return c.json(response);
});

/**
 * GET /v1/me/reviews - the review screen (entered from a push).
 *
 * Two lists come back: holes to fill (open) and holes filled. The quiz and the
 * 1/3/7-day notifications are free (pivot plan §6-3) and get no separate screen.
 *
 * Calling the senpai back by voice requires Premium and uses the same daily slot
 * as a normal lesson. Entitlement is checked at session creation and daily
 * availability is authoritative in `/progress`'s `limits.lesson_allowed_today`,
 * so no differently-named flag is layered onto the queue. Holding the same fact
 * in two places means one gets updated and the branches diverge.
 */
meRoute.get("/reviews", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const today = toLocalDate(at);
  const holes = await repository.listHoles(deviceId);
  const items = holes
    .filter((hole) => hole.status === "open")
    .map((hole) => {
      const daysSince = daysBetween(toLocalDate(new Date(hole.created_at)), today);
      return {
        hole: toHole(hole),
        topic_id: hole.topic_id,
        days_since: daysSince,
        // The review line is shown in the same curriculum language as the hole (same text as the notification).
        prompt: buildReviewPrompt({
          desc: hole.desc,
          daysSince,
          locale: localeOfTopicId(hole.topic_id),
        }),
        // Old data has no quiz. A client-side branch would show a different question per screen.
        quiz: hole.quiz ?? hole.desc,
      };
    })
    // Oldest holes first, then deepest. Speak up about what has been left alone.
    .sort(
      (a, b) =>
        b.days_since - a.days_since ||
        severityRank(b.hole.severity) - severityRank(a.hole.severity),
    );

  const filled = holes
    .filter((hole) => hole.status === "filled" && hole.filled_at !== null)
    .map((hole) => ({
      hole: toHole(hole),
      topic_id: hole.topic_id,
      days_since_filled: daysBetween(toLocalDate(new Date(hole.filled_at as string)), today),
    }))
    // Just-filled ones on top, so the accumulated progress is seen first.
    .sort((a, b) => a.days_since_filled - b.days_since_filled)
    // The lifetime count is authoritative in home's "holes filled" counter
    // (progress). This only carries what the screen shows.
    .slice(0, filledHolesLimit);

  const response: ReviewQueueResponse = {
    items,
    filled,
  };
  return c.json(response);
});

/**
 * GET /v1/me/parent-report - this month's kartes, in a form parents can see.
 *
 * The parent report is Premium, but free users do not get a 402. As with
 * reviews, returning "not unlocked yet" as a 200 lets the app treat it as a
 * purchase flow rather than an error screen. While locked, no body is returned,
 * and the contract's discriminated union prevents leaks too.
 */
meRoute.get("/parent-report", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const user = await repository.ensureUser(deviceId, at);
  if (!hasPremiumAccess({ user, now: at, limits: readLimits(c.env) })) {
    const locked: ParentReportResponse = { requires_premium: true, report: null };
    return c.json(locked);
  }

  const today = toLocalDate(at);
  const period = currentMonthPeriod(today);
  const [sessionDates, holes, kartes] = await Promise.all([
    repository.sessionDates(deviceId),
    repository.listHoles(deviceId),
    repository.listKartesOnLocalDates({
      deviceId,
      fromDate: period.start_date,
      toDate: period.end_date,
    }),
  ]);

  const response: ParentReportResponse = {
    requires_premium: false,
    report: computeParentReport({
      today,
      sessionDates,
      holes,
      kartes,
      limits: {
        quoteCount: parentReportQuoteMaxCount,
        quoteLength: parentReportQuoteMaxLength,
        topicCount: parentReportTopicMaxCount,
      },
    }),
  };
  return c.json(response);
});

/**
 * POST /v1/me/reviews/{holeId} - the 10-second quiz's self-report.
 *
 * This is not grading. The server judges nothing and only records what the
 * student reported. `not_yet` is not a failure, so nothing is decremented and
 * nothing is recorded - counting how often they chose "not yet" would itself
 * become a score.
 */
meRoute.post("/reviews/:holeId", async (c) => {
  const { repository, scheduler, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const parsed = reviewAnswerRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "回答を読み取れませんでした。もう一度選んでみてください。",
        },
      },
      400,
    );
  }

  const hole = await repository.getHole(c.req.param("holeId"));
  // Nonexistent and not-yours both return the same 404: no touching others' holes, and no leaking existence.
  if (!hole || hole.device_id !== deviceId) throw apiError("hole_not_found");

  // Acting only when open means a resent "I said it" neither double-counts nor re-cancels notifications.
  if (parsed.data.outcome === "said_it" && hole.status === "open") {
    await repository.markHoleFilled(hole.id, at.toISOString());
    const cancelled = await repository.cancelReviewSchedules(hole.id);
    for (const entry of cancelled) {
      if (entry.external_id) await scheduler.cancel(entry.external_id);
    }
  }

  // `not_yet` skips all of the saving above, leaving the open hole and its notifications alone.
  const [sessionDates, holes] = await Promise.all([
    repository.sessionDates(deviceId),
    repository.listHoles(deviceId),
  ]);
  const currentHole = holes.find((candidate) => candidate.id === hole.id);
  if (!currentHole) throw apiError("hole_not_found");

  const response: ReviewAnswerResponse = {
    hole: toHole(currentHole),
    progress: computeProgress(sessionDates, holes, toLocalDate(at)),
  };
  return c.json(response);
});

/** D1 row -> contract Hole. evidence / quiz are dropped by key rather than set to null. */
function toHole(hole: HoleRecord): Hole {
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

function severityRank(severity: string): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}
