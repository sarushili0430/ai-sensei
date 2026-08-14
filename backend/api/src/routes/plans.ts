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
 * POST /v1/plans - opens a room for building a study plan by voice.
 *
 * Planning is Premium because it incurs variable LLM and voice cost, but it does
 * not consume the daily lesson slot. Mixing it in would make merely building a
 * plan count as "had a lesson today" and even extend the streak.
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
   * The row is created before the token, so complete never loses the session even
   * if the agent returns a plan immediately after connecting. A row whose token
   * issue failed just stays open, consuming neither a lesson slot nor a plan, so
   * no risky compensating delete is needed.
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
 * POST /v1/plans/{id}/complete - the save endpoint only the plan agent calls.
 *
 * Not left to the agent's own matching. The same guardrail runs again right
 * before saving LLM output, so a bug in regeneration or an old agent cannot leave
 * out-of-scope assignments in the parent report's primary data.
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
    // The contract does not know "today", so it cannot check the lower bound. The server date at save time is the only truth.
    log?.warn("plan_past_day_rejected", { plan_session_id: session.id, today });
    throw apiError("out_of_scope", { locale: session.locale });
  }

  const current = await repository.getCurrentPlan(session.device_id);
  const isRevision = current !== null;
  if (isRevision !== (body.plan.revision !== null)) {
    // Never invent the student's own words for a rebuild after the fact. If missing, do not save and return a failure to the agent.
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
        // On hitting the cap, drop the oldest records. Keeping the recent "why it was
        // rebuilt" as material for explaining to parents suits the contract's purpose
        // better than making the current plan unsavable.
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
    // A concurrent resend finished first. Return what was actually saved, not what we built.
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

/** GET /v1/me/plan - not-yet-created is null, not 404, so the screen can offer creation directly. */
planMeRoute.get("/", async (c) => {
  const { repository } = c.get("services");
  const response: PlanResponse = { plan: await repository.getCurrentPlan(c.get("deviceId")) };
  return c.json(response);
});

/** As in sessions.ts, named agents get explicit dispatch on the token. */
function agentDispatch(env: Bindings, metadata: string): AgentDispatch | undefined {
  const name = env.LIVEKIT_AGENT_NAME?.trim();
  return name ? { name, metadata } : undefined;
}
