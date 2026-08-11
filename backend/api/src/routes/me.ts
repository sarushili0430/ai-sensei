import type { ProgressResponse, ReviewQueueResponse } from "@ai-sensei/contract";
import { filledHolesLimit } from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import { buildReviewPrompt, computeProgress, daysBetween, toLocalDate } from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { readLimits } from "../env.ts";
import { canStartSessionToday, isPremiumNow } from "../lib/entitlement.ts";
import type { HoleRecord } from "../repository/types.ts";

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
      lesson_allowed_today: canStartSessionToday({ user, sessionsToday, now: at, limits }),
    },
  };
  return c.json(response);
});

/**
 * GET /v1/me/reviews — 復習画面(プッシュ起点)。
 *
 * 返すのは2つ。「埋めにいく穴」(open)と「埋めた穴」(filled)。
 * 後者がペイウォールの謳う Premium の「履歴」で、別画面は作らない。
 *
 * 復習はPremium機能なので、無料ユーザーには空配列を返す。
 * エラーにはしない(「使えない」ではなく「まだ開いていない」として見せる)。
 */
meRoute.get("/reviews", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const user = await repository.ensureUser(deviceId, at);
  if (!isPremiumNow(user, at)) {
    const locked: ReviewQueueResponse = { items: [], filled: [], requires_premium: true };
    return c.json(locked);
  }

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
        // 復習画面の一行も、穴と同じ課程の言語で出す(通知文と同じ文面)。
        prompt: buildReviewPrompt({
          desc: hole.desc,
          daysSince,
          locale: localeOfTopicId(hole.topic_id),
        }),
      };
    })
    // 古い穴 → 深い穴の順。放置されたものから声をかける。
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
    // 埋めたばかりのものを上に。積み上がった手応えが先に目に入るように。
    .sort((a, b) => a.days_since_filled - b.days_since_filled)
    // 通算の件数はホームの「埋めた穴」カウンター(progress)のほうが正。
    // ここは画面に出すぶんだけを載せる。
    .slice(0, filledHolesLimit);

  const response: ReviewQueueResponse = { items, filled, requires_premium: false };
  return c.json(response);
});

/** D1の行 → 契約の Hole。evidence は null を持たせず、キーごと落とす。 */
function toHole(hole: HoleRecord) {
  return {
    id: hole.id,
    topic_id: hole.topic_id,
    desc: hole.desc,
    severity: hole.severity,
    ...(hole.evidence ? { evidence: hole.evidence } : {}),
    status: hole.status,
    created_at: hole.created_at,
    filled_at: hole.filled_at,
  };
}

function severityRank(severity: string): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}
