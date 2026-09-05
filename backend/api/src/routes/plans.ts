import {
  type CompletePlanSessionResponse,
  type CreatePlanSessionResponse,
  type PlanResponse,
  type PlanSessionMetadata,
  completePlanSessionRequestSchema,
  createPlanSessionRequestSchema,
  planSessionMetadataSchema,
  studyPlanSchema,
} from "@ai-sensei/contract";
import { checkPlanScope, filterPlanItems, toLocalDate } from "@ai-sensei/guardrail";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../env.ts";
import { readLimits } from "../env.ts";
import { hasPremiumAccess } from "../lib/entitlement.ts";
import { apiError } from "../lib/errors.ts";
import { type AgentDispatch, createLiveKitToken } from "../lib/livekit.ts";

export const plansRoute = new Hono<AppEnv>();
export const planMeRoute = new Hono<AppEnv>();

/**
 * POST /v1/plans — 音声で学習計画を作る部屋を開く。
 *
 * 計画はLLMと音声の変動原価が発生するためPremiumだが、日次の授業枠は消費しない。
 * 授業枠へ混ぜると、計画を組んだだけで「今日は授業済み」になり、連続日数まで増えるため。
 */
plansRoute.post("/", async (c) => {
  const { repository, now, newId } = c.get("services");
  const log = c.get("log");
  const deviceId = c.get("deviceId");
  const at = now();

  const parsed = createPlanSessionRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    log?.warn("plan_session_invalid_payload", { issue_count: parsed.error.issues.length });
    return c.json({ error: { code: "internal_error", message: parsed.error.message } }, 400);
  }
  const { locale, school_stage: schoolStage } = parsed.data;

  const limits = readLimits(c.env);
  const user = await repository.ensureUser(deviceId, at);
  if (!hasPremiumAccess({ user, now: at, limits })) {
    throw apiError("premium_required", { locale });
  }

  const planSessionId = newId("pls");
  const maxSeconds = limits.premiumSessionMaxSeconds;
  const currentPlan = await repository.getCurrentPlan(deviceId);
  const metadata = planSessionMetadataSchema.parse({
    plan_session_id: planSessionId,
    kind: "plan",
    locale,
    school_stage: schoolStage,
    max_seconds: maxSeconds,
    today: toLocalDate(at),
    current_plan: currentPlan,
  } satisfies PlanSessionMetadata);
  const metadataJson = JSON.stringify(metadata);

  /**
   * トークンより先に行を作る。agentが接続直後に計画を返すほど速くても、complete側が
   * セッションを見失わないため。トークン発行が失敗した行はopenのまま残るだけで、
   * 授業枠も計画本体も消費しないので、危険な補償削除はしない。
   */
  await repository.createPlanSession({
    id: planSessionId,
    device_id: deviceId,
    locale,
    status: "open",
    created_at: at.toISOString(),
    completed_at: null,
    duration_seconds: null,
    plan_id: null,
  });

  const dispatch = agentDispatch(c.env, metadataJson);
  const token = await createLiveKitToken({
    apiKey: c.env.LIVEKIT_API_KEY,
    apiSecret: c.env.LIVEKIT_API_SECRET,
    identity: deviceId,
    room: planSessionId,
    ttlSeconds: maxSeconds + 120,
    metadata: metadataJson,
    agent: dispatch,
    now: at,
  });

  log?.info("plan_session_created", {
    plan_session_id: planSessionId,
    locale,
    has_current_plan: currentPlan !== null,
    agent_dispatch: dispatch ? "explicit" : "automatic",
  });

  const response: CreatePlanSessionResponse = {
    plan_session_id: planSessionId,
    livekit: { url: c.env.LIVEKIT_URL, token, room: planSessionId },
    current_plan: currentPlan,
  };
  return c.json(response, 201);
});

/**
 * POST /v1/plans/{id}/complete — 計画agentだけが呼ぶ保存口。
 *
 * agent側の照合だけに任せない。LLM出力を保存する直前にも同じ guardrail を通し、
 * 再生成処理の不具合や古いagentが、範囲外の割り当てを親レポートの一次データへ残すのを防ぐ。
 */
plansRoute.post("/:planSessionId/complete", async (c) => {
  const { repository, now, newId } = c.get("services");
  const log = c.get("log");
  const at = now();
  const planSessionId = c.req.param("planSessionId");

  if (c.req.header("authorization") !== `Bearer ${c.env.INTERNAL_API_TOKEN}`) {
    log?.warn("plan_complete_unauthorized", { plan_session_id: planSessionId });
    throw apiError("unauthorized");
  }

  const session = await repository.getPlanSession(planSessionId);
  if (!session) throw apiError("session_not_found");

  if (session.status === "completed" && session.plan_id) {
    const existing = await repository.getPlan(session.plan_id);
    if (!existing) throw new Error(`完了済み計画セッションの計画がありません: ${session.id}`);
    log?.info("plan_complete_replayed", { plan_session_id: session.id, plan_id: existing.id });
    const response: CompletePlanSessionResponse = { plan: existing };
    return c.json(response, 200);
  }

  const parsed = completePlanSessionRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    log?.error("plan_complete_invalid_payload", parsed.error, {
      plan_session_id: session.id,
    });
    return c.json({ error: { code: "internal_error", message: parsed.error.message } }, 400);
  }
  const body = parsed.data;

  const scope = checkPlanScope(body.plan.intake.scope.topic_ids);
  if (!scope.ok) {
    log?.warn("plan_scope_rejected", {
      plan_session_id: session.id,
      reason: scope.reason,
      detail: scope.detail,
    });
    throw apiError("out_of_scope", { locale: session.locale });
  }

  const rejected = body.plan.days.flatMap(
    (day) => filterPlanItems(day.items, scope.allowed).rejected,
  );
  if (rejected.length > 0) {
    log?.warn("plan_items_rejected", {
      plan_session_id: session.id,
      reasons: rejected.map((entry) => entry.reason),
    });
    throw apiError("out_of_scope", { locale: session.locale });
  }

  const today = toLocalDate(at);
  if (body.plan.days.some((day) => day.date < today)) {
    // contractは「今日」を知らないので下限を検査できない。保存時のサーバ日付が唯一の正。
    log?.warn("plan_past_day_rejected", { plan_session_id: session.id, today });
    throw apiError("out_of_scope", { locale: session.locale });
  }

  const current = await repository.getCurrentPlan(session.device_id);
  const isRevision = current !== null;
  if (isRevision !== (body.plan.revision !== null)) {
    // 組み直しの本人の言葉を後付けで作文しない。欠けていれば保存せず、agentに失敗を返す。
    log?.warn("plan_revision_mismatch", {
      plan_session_id: session.id,
      has_current_plan: isRevision,
      has_revision: body.plan.revision !== null,
    });
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "計画の新規作成と組み直しの契約が一致しません",
        },
      },
      409,
    );
  }

  const createdAt = current?.created_at ?? at.toISOString();
  const planId = current?.id ?? newId("pln");
  const revisions = body.plan.revision
    ? [
        // 上限に達したら古い記録から落とす。現行計画を保存不能にするより、直近の
        // 「なぜ組み直したか」を親への説明材料として残すほうが契約の目的に合う。
        ...(current?.revisions.slice(-19) ?? []),
        { ...body.plan.revision, at: at.toISOString() },
      ]
    : [];
  const plan = studyPlanSchema.parse({
    id: planId,
    created_at: createdAt,
    source: body.source,
    intake: body.plan.intake,
    days: body.plan.days.map((day) => ({
      date: day.date,
      items: day.items.map((item) => ({ ...item, status: "todo" as const })),
    })),
    revisions,
  });

  const saved = await repository.completePlanSession({
    sessionId: session.id,
    completedAt: at.toISOString(),
    durationSeconds: Math.min(body.duration_seconds, 60 * 60),
    plan,
  });
  if (!saved) {
    // 同時再送が先に完了した。こちらで組んだ値ではなく、実際に保存された値を返す。
    const completed = await repository.getPlanSession(session.id);
    const existing = completed?.plan_id ? await repository.getPlan(completed.plan_id) : null;
    if (!existing)
      throw new Error(`計画セッションの競合後に保存済み計画がありません: ${session.id}`);
    const response: CompletePlanSessionResponse = { plan: existing };
    return c.json(response, 200);
  }

  log?.info("plan_completed", {
    plan_session_id: session.id,
    plan_id: plan.id,
    source: plan.source,
    revised: isRevision,
    day_count: plan.days.length,
  });
  const response: CompletePlanSessionResponse = { plan };
  return c.json(response, 201);
});

/** GET /v1/me/plan — 未作成は404ではなくnull。画面がそのまま作成導線を出せる。 */
planMeRoute.get("/", async (c) => {
  const { repository } = c.get("services");
  const response: PlanResponse = { plan: await repository.getCurrentPlan(c.get("deviceId")) };
  return c.json(response);
});

/** sessions.ts と同じく、名前つきagentではトークンに明示ディスパッチを載せる。 */
function agentDispatch(env: Bindings, metadata: string): AgentDispatch | undefined {
  const name = env.LIVEKIT_AGENT_NAME?.trim();
  return name ? { name, metadata } : undefined;
}
