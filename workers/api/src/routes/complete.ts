import {
  type CompleteSessionResponse,
  type Hole,
  completeSessionRequestSchema,
} from "@ai-sensei/contract";
import {
  buildAllowedTopics,
  computeProgress,
  filterHoleTopicIds,
  scheduleReviews,
  toLocalDate,
} from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { isPremiumNow, shouldShowPaywall } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import type { HoleRecord, KarteRecord, ReviewScheduleRecord } from "../repository/types.ts";

export const completeRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions/{id}/complete — agentが呼ぶ内部エンドポイント。
 *
 * transcriptとカルテ下書きを受け取り、
 *   1. 穴のtopic_idをこのセッションの許可リストで照合(ガードレール2枚目)
 *   2. カルテと穴をD1に保存
 *   3. 翌日/3日後/7日後の復習プッシュをOneSignalに予約
 *   4. 復習セッションだった場合は、対象の穴を「埋まった」にする
 * を行う。
 */
completeRoute.post("/:sessionId/complete", async (c) => {
  const { repository, scheduler, now, newId } = c.get("services");
  const at = now();

  const authorized = c.req.header("authorization") === `Bearer ${c.env.INTERNAL_API_TOKEN}`;
  if (!authorized) throw apiError("unauthorized");

  const session = await repository.getSession(c.req.param("sessionId"));
  if (!session) throw apiError("session_not_found");

  const parsed = completeSessionRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: { code: "internal_error", message: parsed.error.message } }, 400);
  }
  const body = parsed.data;

  const durationSeconds = Math.min(body.duration_seconds, 60 * 60);
  await repository.completeSession({
    sessionId: session.id,
    completedAt: at.toISOString(),
    durationSeconds,
  });

  // 会話中に許可範囲を越えたタグが付いていたら、ここで落とす。
  // 的外れなタグを残すと、復習の通知まで的外れになる。
  const allowed = buildAllowedTopics(session.topic_ids);
  const { accepted: acceptedHoles, rejected } = filterHoleTopicIds(body.karte.holes, allowed);
  if (rejected.length > 0) {
    const dropped = rejected.map((entry) => `${entry.hole.topic_id}(${entry.reason})`).join(", ");
    console.warn(
      `[guardrail] session=${session.id} 許可外のtopic_idが付いた穴を落としました: ${dropped}`,
    );
  }

  const karteId = newId("kar");
  const holeRecords: HoleRecord[] = acceptedHoles.map((hole) => ({
    id: newId("hol"),
    device_id: session.device_id,
    karte_id: karteId,
    topic_id: hole.topic_id,
    desc: hole.desc,
    severity: hole.severity,
    evidence: hole.evidence ?? null,
    status: "open",
    created_at: at.toISOString(),
    filled_at: null,
  }));

  const user = await repository.getUser(session.device_id);
  const premium = isPremiumNow(user, at);

  const karteRecord: KarteRecord = {
    id: karteId,
    session_id: session.id,
    device_id: session.device_id,
    created_at: at.toISOString(),
    topic_ids: session.topic_ids,
    said_well: body.karte.said_well,
    term_notes: body.karte.term_notes,
    // あと追い質問はPremium機能。無料ユーザーには保存もしない。
    followup_question: premium ? (body.karte.followup_question ?? null) : null,
  };
  await repository.insertKarte(karteRecord, holeRecords);

  // 復習セッションなら、対象の穴を埋まったことにして残りの通知を取り消す
  let filledThisSession = 0;
  if (session.kind === "review" && session.hole_id) {
    const target = await repository.getHole(session.hole_id);
    if (target && target.status === "open") {
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
      });
      externalId = scheduled.externalId;
    } catch (error) {
      // 通知の予約に失敗しても、カルテは返す。プッシュのために体験を止めない。
      console.error(`[onesignal] 予約に失敗: hole=${hole.id}`, error);
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
      // セッション回数ではなく「カルテができた日数」で数えるので、
      // 同じ日に何度やってもペイウォールは初回の1回だけになる。
      completedSessionCount: sessionDates.length,
      holesFound: holeRecords.length,
    }),
  };

  if (filledThisSession > 0) {
    console.info(`[progress] session=${session.id} 埋まった穴: ${filledThisSession}`);
  }

  return c.json(response, 201);
});

function toHolePayload(hole: HoleRecord): Hole {
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
