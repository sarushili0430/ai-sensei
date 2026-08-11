import type {
  ParentReportResponse,
  ProgressResponse,
  ReviewQueueResponse,
} from "@ai-sensei/contract";
import {
  filledHolesLimit,
  parentReportQuoteMaxCount,
  parentReportQuoteMaxLength,
  parentReportTopicMaxCount,
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
import { canStartSessionToday, isPremiumNow } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
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

/**
 * GET /v1/me/parent-report — 今月のカルテを、親へ見せられる形にする。
 *
 * 親レポートはPremiumだが、無料ユーザーを402にはしない。復習と同じく
 * 「まだ開いていない」状態を200で返すと、アプリは失敗画面ではなく
 * 課金導線として扱える。ロック中は本文を返さず、契約の判別共用体でも漏れを防ぐ。
 */
meRoute.get("/parent-report", async (c) => {
  const { repository, now } = c.get("services");
  const at = now();
  const deviceId = c.get("deviceId");

  const user = await repository.ensureUser(deviceId, at);
  if (!isPremiumNow(user, at)) {
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
 * POST /v1/me/holes/{holeId}/filled — 本人の自己申告だけで穴を埋める。
 *
 * カルテや会話ログから自動判定しない。計画書 §2 が採点者を本人に限定しているのは、
 * AIの誤読を「正しく理解した」に変えて、その誤りを1/3/7日の通知で強化しないため。
 * このルートが受け取る事実は、ボタンを押したことだけ。
 */
meRoute.post("/holes/:holeId/filled", async (c) => {
  const { repository, scheduler, now } = c.get("services");
  const deviceId = c.get("deviceId");
  const target = await repository.getHole(c.req.param("holeId"));

  // 存在しないIDと他人のIDを同じ404に畳む。違う応答にすると、匿名デバイス認証でも
  // hole_idを順に試して他人の学習記録が存在するかだけは調べられてしまう。
  // 復習セッション開始時と同じく、所有者はリクエストのdevice_idと突き合わせる。
  if (!target || target.device_id !== deviceId) throw apiError("session_not_found");

  // UPDATEは open のときだけ効くので、再送で「埋めた日」が今日へ動かない。
  // 一方、通知の掃除は filled でも毎回通す。状態更新の直後に処理が途切れた再送で
  // ここを飛ばすと、画面では埋まっているのに3日後の通知だけが届くため。
  await repository.markHoleFilled(target.id, now().toISOString());
  const cancelled = await repository.cancelReviewSchedules(target.id);
  for (const entry of cancelled) {
    if (entry.external_id) await scheduler.cancel(entry.external_id);
  }

  // クライアントは復習キューと進捗をサーバから読み直す。ここで穴を返して
  // もう1つの状態を持たせると、取消まで終わった事実と画面の状態がずれうる。
  return c.body(null, 204);
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
