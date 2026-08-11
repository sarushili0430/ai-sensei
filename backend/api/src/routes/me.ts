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
 * 小テストと1/3/7日の通知は無料(ピボット計画 §6-3)で、別画面も作らない。
 *
 * 音声で「先輩を呼び直す」ときはPremiumかつ通常の授業と同じ日次枠を使う。
 * 契約判定はセッション作成側、日次の可否は `/progress` の
 * `limits.lesson_allowed_today` が正なので、キューに別名のフラグを重ねない。
 * 同じことを2か所で持つと、片方だけ更新されて分岐がずれるため。
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
        // 復習画面の一行も、穴と同じ課程の言語で出す(通知文と同じ文面)。
        prompt: buildReviewPrompt({
          desc: hole.desc,
          daysSince,
          locale: localeOfTopicId(hole.topic_id),
        }),
        // 旧データには出題が無い。クライアントに分岐を持たせると画面ごとに違う問いが出る。
        quiz: hole.quiz ?? hole.desc,
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

  const response: ReviewQueueResponse = {
    items,
    filled,
  };
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
 * POST /v1/me/reviews/{holeId} — 10秒小テストの自己申告。
 *
 * ここは**採点ではない**。サーバは正誤を判定せず、本人の申告をそのまま記録するだけ。
 * `not_yet` は失敗ではないので、何も減らさず、何も記録しない。「まだ」を選んだ
 * 回数を数えると、それ自体が点数になってしまう。
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
  // 存在の有無と所有者の違いを同じ404にして、他人の穴を触らせず、存在も漏らさない。
  if (!hole || hole.device_id !== deviceId) throw apiError("hole_not_found");

  // openのときだけ動かすことで、「言えた」の再送でも二重に数えず、通知も再取消ししない。
  if (parsed.data.outcome === "said_it" && hole.status === "open") {
    await repository.markHoleFilled(hole.id, at.toISOString());
    const cancelled = await repository.cancelReviewSchedules(hole.id);
    for (const entry of cancelled) {
      if (entry.external_id) await scheduler.cancel(entry.external_id);
    }
  }

  // `not_yet` では上の保存処理を一切通らない。openの穴と通知をそのまま残す。
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

/** D1の行 → 契約の Hole。evidence / quiz は null を持たせず、キーごと落とす。 */
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
