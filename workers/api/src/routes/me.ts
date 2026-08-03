import type { ProgressResponse, ReviewQueueResponse } from "@ai-sensei/contract";
import { buildReviewPrompt, computeProgress, daysBetween, toLocalDate } from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { readLimits } from "../env.ts";
import { isPremiumNow } from "../lib/entitlement.ts";

export const meRoute = new Hono<AppEnv>();

/** GET /v1/me/progress — ホーム画面のカウンター。 */
meRoute.get("/progress", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");
  const limits = readLimits(c.env);

  const user = await repository.ensureUser(deviceId, at);
  const premium = isPremiumNow(user, at);
  const localDate = toLocalDate(at);

  const [sessionDates, holes, sessionsToday] = await Promise.all([
    repository.sessionDates(deviceId),
    repository.listHoles(deviceId),
    repository.countSessionsOnDate(deviceId, localDate),
  ]);

  const response: ProgressResponse = {
    progress: computeProgress(sessionDates, holes, localDate),
    is_premium: premium,
    limits: {
      max_seconds: premium ? limits.premiumSessionMaxSeconds : limits.freeSessionMaxSeconds,
      remaining_sessions_today: premium
        ? null
        : Math.max(0, limits.freeSessionsPerDay - sessionsToday),
    },
  };
  return c.json(response);
});

/**
 * GET /v1/me/reviews — 復習画面(プッシュ起点)。
 * 復習はPremium機能なので、無料ユーザーには空配列を返す。
 * エラーにはしない(「使えない」ではなく「まだ開いていない」として見せる)。
 */
meRoute.get("/reviews", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const user = await repository.ensureUser(deviceId, at);
  if (!isPremiumNow(user, at)) {
    const locked: ReviewQueueResponse = { items: [], requires_premium: true };
    return c.json(locked);
  }

  const today = toLocalDate(at);
  const holes = await repository.listHoles(deviceId);
  const items = holes
    .filter((hole) => hole.status === "open")
    .map((hole) => {
      const daysSince = daysBetween(toLocalDate(new Date(hole.created_at)), today);
      return {
        hole: {
          id: hole.id,
          topic_id: hole.topic_id,
          desc: hole.desc,
          severity: hole.severity,
          ...(hole.evidence ? { evidence: hole.evidence } : {}),
          status: hole.status,
          created_at: hole.created_at,
          filled_at: hole.filled_at,
        },
        topic_id: hole.topic_id,
        days_since: daysSince,
        prompt: buildReviewPrompt({ desc: hole.desc, daysSince }),
      };
    })
    // 古い穴 → 深い穴の順。放置されたものから声をかける。
    .sort(
      (a, b) =>
        b.days_since - a.days_since ||
        severityRank(b.hole.severity) - severityRank(a.hole.severity),
    );

  const response: ReviewQueueResponse = { items, requires_premium: false };
  return c.json(response);
});

function severityRank(severity: string): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}
