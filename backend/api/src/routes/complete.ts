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
import {
  canStartSessionToday,
  hasPremiumAccess,
  secondsPerDay,
  sessionMaxSeconds,
  shouldShowPaywall,
} from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import type {
  DailySessionUsage,
  HoleRecord,
  KarteRecord,
  Repository,
  ReviewScheduleRecord,
  SessionRecord,
  UserRecord,
} from "../repository/types.ts";

export const completeRoute = new Hono<AppEnv>();

/**
 * POST /v1/sessions/{id}/complete — agentが呼ぶ内部エンドポイント。
 *
 * transcriptとカルテ下書きを受け取り、
 *   1. 穴のtopic_idをこのセッションの許可リストで照合(ガードレール2枚目)
 *   2. カルテと穴をD1に保存
 *   3. 翌日/3日後/7日後の復習プッシュをOneSignalに予約
 *   4. 復習セッションで本人が「言えた」と申告した場合は、対象の穴を「埋まった」にする
 * を行う。
 */
completeRoute.post("/:sessionId/complete", async (c) => {
  const { repository, scheduler, now, newId } = c.get("services");
  const log = c.get("log");
  const at = now();

  const authorized = c.req.header("authorization") === `Bearer ${c.env.INTERNAL_API_TOKEN}`;
  if (!authorized) {
    // agent と API で内部トークンがずれていると、会話は成立するのにカルテだけ
    // 落ちる。アプリからは「カルテが出ない」としか見えないので、ここに残す。
    log?.warn("complete_unauthorized", { session_id: c.req.param("sessionId") });
    throw apiError("unauthorized");
  }

  const session = await repository.getSession(c.req.param("sessionId"));
  if (!session) throw apiError("session_not_found");

  // agentがタイムアウトで再送してくることがある。素通しすると、カルテも穴も
  // 通知予約も二重に作られて進捗が壊れるので、既にあるものをそのまま返す。
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
    // カルテの契約が壊れている。agent側のLLM出力かスキーマのずれ。
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

  // 会話中に許可範囲を越えたタグが付いていたら、ここで直す。
  // 的外れなタグを残すと復習の通知まで的外れになるが、**穴そのものは捨てない** —
  // 外れているのはLLMが付けたIDであって、本人が説明に詰まった事実ではない。
  // 捨てるとカルテが空になり、画面には「止まらずに説明できました」と出てしまう。
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
    // 付け替える先が無いセッションだけは落とす。
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
  const currentLimits = readLimits(c.env);
  const premium = hasPremiumAccess({ user, now: at, limits: currentLimits });

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

  // 復習の穴は、AIの採点ではなく本人が「言えた」と申告したときだけ埋める。
  // 接続しただけのセッションで自動的に埋めると、説明できたかを本人が決められなくなる。
  let filledThisSession = 0;
  if (session.kind === "review" && session.hole_id && body.review_outcome === "said_it") {
    const target = await repository.getHole(session.hole_id);
    // 他人の穴を埋めてしまわないよう、セッションの持ち主と突き合わせる
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
        // 通知の言語は穴のtopic_idから引く。カルテの文言はその課程の言語で
        // 書かれているので、端末の設定ではなくこちらが正。
        locale: localeOfTopicId(hole.topic_id),
      });
      externalId = scheduled.externalId;
    } catch (error) {
      // 通知の予約に失敗しても、カルテは返す。プッシュのために体験を止めない。
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
  const usage = await repository.getDailySessionUsage(session.device_id, toLocalDate(at));

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
    limits: sessionLimitsPayload({ user, usage, at, limits: currentLimits }),
    show_paywall: shouldShowPaywall({
      isPremium: premium,
      // セッション回数ではなく「カルテができた日数」で数えるので、
      // 同じ日に何度やってもペイウォールは初回の1回だけになる。
      completedSessionCount: sessionDates.length,
      holesFound: holeRecords.length,
    }),
  };

  // 会話が成立したかどうかは、この1行で分かる(穴0件は失敗ではない)。
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
 * 保存済みのカルテからレスポンスを組み立て直す。
 *
 * - agentからの再送(/complete が二度呼ばれた場合)
 * - アプリからの結果取得(GET /v1/sessions/{id}/result)
 *
 * の両方で使う。会話が終わってからカルテができるまでには数秒かかるので、
 * アプリは完了後にこのエンドポイントを見に来る。
 */
export async function buildResponse(input: {
  repository: Repository;
  at: Date;
  session: SessionRecord;
  stored: { karte: KarteRecord; holes: HoleRecord[] };
  limits: Limits;
}): Promise<CompleteSessionResponse> {
  const { repository, at, session, stored, limits } = input;

  const localDate = toLocalDate(at);
  const [sessionDates, allHoles, user, usage] = await Promise.all([
    repository.sessionDates(session.device_id),
    repository.listHoles(session.device_id),
    repository.getUser(session.device_id),
    repository.getDailySessionUsage(session.device_id, localDate),
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
    progress: computeProgress(sessionDates, allHoles, localDate),
    limits: sessionLimitsPayload({ user, usage, at, limits }),
    show_paywall: shouldShowPaywall({
      isPremium: hasPremiumAccess({ user, now: at, limits }),
      completedSessionCount: sessionDates.length,
      holesFound: stored.holes.length,
    }),
  };
}

/** 完了実績で仮押さえを精算した直後の、ホームと同じ日次残高。 */
function sessionLimitsPayload(input: {
  user: UserRecord | null;
  usage: DailySessionUsage;
  at: Date;
  limits: Limits;
}): {
  max_seconds: number;
  remaining_seconds_today: number;
  lesson_allowed_today: boolean;
} {
  const remainingSecondsToday = Math.max(
    0,
    secondsPerDay({ user: input.user, now: input.at, limits: input.limits }) -
      input.usage.consumedSeconds,
  );
  return {
    max_seconds: sessionMaxSeconds({ user: input.user, now: input.at, limits: input.limits }),
    remaining_seconds_today: remainingSecondsToday,
    lesson_allowed_today: canStartSessionToday({
      remainingSecondsToday,
      sessionsToday: input.usage.sessionsStarted,
    }),
  };
}

/**
 * GET /v1/sessions/{id}/result — アプリが会話後に結果を取りに来る。
 * まだカルテができていなければ 202 を返し、アプリはしばらく待って再度たずねる。
 */
completeRoute.get("/:sessionId/result", async (c) => {
  const { repository, now } = c.get("services");
  const deviceId = c.get("deviceId");
  const at = now();

  const session = await repository.getSession(c.req.param("sessionId"));
  if (!session || session.device_id !== deviceId) throw apiError("session_not_found");

  const stored = await repository.getKarteBySession(session.id);
  if (!stored) {
    // カルテ生成中。アプリはこの状態を「まだ」として扱い、少し待って聞き直す。
    return c.json({ status: "pending" }, 202);
  }

  return c.json(
    await buildResponse({ repository, at, session, stored, limits: readLimits(c.env) }),
    200,
  );
});
