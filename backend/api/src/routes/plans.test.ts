import {
  type CompletePlanSessionRequest,
  type CompletePlanSessionResponse,
  type CreatePlanSessionResponse,
  type PlanResponse,
  createPlanSessionResponseSchema,
  planSessionMetadataSchema,
  studyPlanSchema,
} from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { verifyJwt } from "../lib/livekit.ts";
import {
  type TestServices,
  internalToken,
  testBindings,
  testDeviceId,
  testServices,
} from "../test-support.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

async function makePremium(): Promise<void> {
  await services.repository.ensureUser(testDeviceId, new Date("2026-08-03T13:24:07.000Z"));
  await services.repository.setPremium({
    deviceId: testDeviceId,
    isPremium: true,
    expiresAt: null,
    rcAppUserId: "rc_plan_test",
  });
}

function createPlanSession(locale = "ja") {
  return app.request(
    "/v1/plans",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": testDeviceId },
      body: JSON.stringify({ locale }),
    },
    bindings,
  );
}

function completePlanSession(planSessionId: string, body: unknown, token = internalToken) {
  return app.request(
    `/v1/plans/${planSessionId}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function planRequest(
  overrides: Partial<CompletePlanSessionRequest> = {},
): CompletePlanSessionRequest {
  return {
    plan: {
      intake: {
        exam_name: "2学期の中間",
        exam_date: "2026-08-10",
        scope: {
          topic_ids: ["M2-SANKAKU-KAHO"],
          said: "数IIの三角関数、教科書120〜150ページ",
        },
        materials: ["4STEP"],
      },
      days: [
        {
          date: "2026-08-04",
          items: [
            {
              topic_id: "M2-SANKAKU-KAHO",
              what: "4STEPの加法定理の例題を一周",
              material: 0,
              minutes: 40,
            },
          ],
        },
      ],
      revision: null,
    },
    source: "senpai",
    duration_seconds: 146,
    ended_reason: "completed",
    ...overrides,
  };
}

describe("計画モードAPI", () => {
  it("無料ユーザーにはPremium導線のエラーを返し、回数の数字を文言に出さない", async () => {
    const response = await createPlanSession();
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("premium_required");
    expect(body.error.message).not.toMatch(/[0-9０-９]/);
    expect(services.repository.planSessions.size).toBe(0);
  });

  it("Premiumユーザーへ計画専用metadataのLiveKitトークンを返す", async () => {
    await makePremium();
    const response = await createPlanSession();
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreatePlanSessionResponse;
    expect(createPlanSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.current_plan).toBeNull();

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = planSessionMetadataSchema.parse(JSON.parse(String(claims?.["metadata"])));
    expect(metadata).toMatchObject({
      kind: "plan",
      plan_session_id: body.plan_session_id,
      today: "2026-08-03",
      current_plan: null,
    });
    // Opening a plan adds no row that feeds the lesson streak.
    expect(services.repository.sessions.size).toBe(0);
  });

  it("計画を保存し、GETで現行計画を返す", async () => {
    await makePremium();
    const created = (await (await createPlanSession()).json()) as CreatePlanSessionResponse;
    const completed = await completePlanSession(created.plan_session_id, planRequest());
    expect(completed.status).toBe(201);
    const completedBody = (await completed.json()) as CompletePlanSessionResponse;
    expect(studyPlanSchema.safeParse(completedBody.plan).success).toBe(true);
    expect(completedBody.plan.days[0]?.items[0]?.status).toBe("todo");

    const fetched = await app.request(
      "/v1/me/plan",
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as PlanResponse;
    expect(body.plan).toEqual(completedBody.plan);
  });

  it("計画が無いGETはnullを返す", async () => {
    const response = await app.request(
      "/v1/me/plan",
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: null });
  });

  it("内部トークンが違うcompleteを拒否する", async () => {
    await makePremium();
    const created = (await (await createPlanSession()).json()) as CreatePlanSessionResponse;
    expect(
      (await completePlanSession(created.plan_session_id, planRequest(), "wrong")).status,
    ).toBe(401);
  });

  it("同じcompleteの再送は計画を二重に組み直さない", async () => {
    await makePremium();
    const created = (await (await createPlanSession()).json()) as CreatePlanSessionResponse;
    const request = planRequest();
    const first = (await (
      await completePlanSession(created.plan_session_id, request)
    ).json()) as CompletePlanSessionResponse;
    const replay = await completePlanSession(created.plan_session_id, request);
    expect(replay.status).toBe(200);
    expect((await replay.json()) as CompletePlanSessionResponse).toEqual(first);
  });

  it("範囲外の割り当ては保存直前の二重ガードで落とす", async () => {
    await makePremium();
    const created = (await (await createPlanSession()).json()) as CreatePlanSessionResponse;
    const request = planRequest();
    request.plan.days[0]!.items[0]!.topic_id = "M2-ZUKEI-ENCHOKU";
    const response = await completePlanSession(created.plan_session_id, request);
    expect(response.status).toBe(422);
    expect(services.repository.plans.size).toBe(0);
  });

  it("口頭の組み直しはIDを保ち、本人の言葉をrevisionへ積む", async () => {
    await makePremium();
    const initialSession = (await (await createPlanSession()).json()) as CreatePlanSessionResponse;
    const initial = (await (
      await completePlanSession(initialSession.plan_session_id, planRequest())
    ).json()) as CompletePlanSessionResponse;

    const revisionSession = (await (await createPlanSession()).json()) as CreatePlanSessionResponse;
    expect(revisionSession.current_plan?.id).toBe(initial.plan.id);
    const revisedRequest = planRequest();
    revisedRequest.source = "template";
    revisedRequest.plan.revision = {
      reason: "behind",
      said: "風邪ひいて3日できなかった",
    };
    revisedRequest.plan.days[0]!.items[0]!.minutes = 20;

    const revised = (await (
      await completePlanSession(revisionSession.plan_session_id, revisedRequest)
    ).json()) as CompletePlanSessionResponse;
    expect(revised.plan.id).toBe(initial.plan.id);
    expect(revised.plan.source).toBe("template");
    expect(revised.plan.revisions).toEqual([
      {
        at: "2026-08-03T13:24:07.000Z",
        reason: "behind",
        said: "風邪ひいて3日できなかった",
      },
    ]);
  });
});
