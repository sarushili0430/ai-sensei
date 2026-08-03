import type { CompleteSessionResponse, CreateSessionResponse } from "@ai-sensei/contract";
import { completeSessionResponseSchema } from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  type TestServices,
  createSessionForm,
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

async function startSession(meta: Record<string, unknown> = {}): Promise<string> {
  const response = await app.request(
    "/v1/sessions",
    {
      method: "POST",
      body: createSessionForm(meta),
      headers: { "x-device-id": testDeviceId },
    },
    bindings,
  );
  return ((await response.json()) as CreateSessionResponse).session_id;
}

const karteDraft = {
  said_well: ["中心と直線の距離で判定する方針を、理由つきで説明できた"],
  holes: [
    {
      topic_id: "M1-NIJI-HANBETSU",
      desc: "判別式を「なぜ」使うのか、で説明が止まった",
      severity: "medium" as const,
      evidence: "そこは……なんとなくです",
    },
  ],
  term_notes: ["「解の公式」と「判別式」が混ざっていた"],
  followup_question: "判別式が0のとき、グラフはどうなってるんでしたっけ?",
};

function complete(
  sessionId: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = { authorization: `Bearer ${internalToken}` },
) {
  return app.request(
    `/v1/sessions/${sessionId}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        transcript: [
          { role: "assistant", text: "なんで距離で比べたんですか?", at_ms: 1000 },
          { role: "user", text: "半径と比べたかったからです", at_ms: 8000 },
        ],
        karte: karteDraft,
        duration_seconds: 268,
        ended_reason: "completed",
        ...body,
      }),
    },
    bindings,
  );
}

describe("POST /v1/sessions/{id}/complete", () => {
  it("カルテを保存し、契約どおりのレスポンスを返す", async () => {
    const sessionId = await startSession();
    const response = await complete(sessionId);
    expect(response.status).toBe(201);

    const body = (await response.json()) as CompleteSessionResponse;
    const parsed = completeSessionResponseSchema.safeParse(body);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    expect(body.karte.holes).toHaveLength(1);
    expect(body.karte.holes[0]?.status).toBe("open");
  });

  it("内部トークンがなければ401(agentからの呼び出しのみ許す)", async () => {
    const sessionId = await startSession();
    const response = await complete(sessionId, {}, {});
    expect(response.status).toBe(401);
  });

  it("存在しないセッションは404", async () => {
    const response = await complete("ses_nonexistent");
    expect(response.status).toBe(404);
  });

  it("翌日・3日後・7日後の3件を予約する", async () => {
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;

    expect(body.review_schedule.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(services.scheduler.scheduled).toHaveLength(3);
    expect(services.scheduler.scheduled[0]?.sendAt).toBe("2026-08-04T11:00:00.000Z");
  });

  it("通知文は後輩からのお願いの形にする", async () => {
    const sessionId = await startSession();
    await complete(sessionId);
    // buildReviewPromptがスケジューラ側で使われる。descがそのまま渡ること。
    expect(services.scheduler.scheduled[0]?.desc).toContain("判別式");
  });

  // 会話中に許可範囲を越えたタグが付くと、復習の通知まで的外れになる
  it("許可リスト外のtopic_idが付いた穴を落とす", async () => {
    const sessionId = await startSession();
    const body = (await (
      await complete(sessionId, {
        karte: {
          ...karteDraft,
          holes: [
            ...karteDraft.holes,
            { topic_id: "MB-SURETSU-SIGMA", desc: "Σで止まった", severity: "low" as const },
          ],
        },
      })
    ).json()) as CompleteSessionResponse;

    expect(body.karte.holes.map((hole) => hole.topic_id)).toEqual(["M1-NIJI-HANBETSU"]);
  });

  it("穴が0件の会話でもカルテは作る(空のカルテは失敗ではない)", async () => {
    const sessionId = await startSession();
    const body = (await (
      await complete(sessionId, { karte: { ...karteDraft, holes: [] } })
    ).json()) as CompleteSessionResponse;

    expect(body.karte.holes).toEqual([]);
    expect(body.review_schedule).toEqual([]);
    expect(services.scheduler.scheduled).toHaveLength(0);
  });

  it("あと追い質問は無料ユーザーには保存しない(Premium機能)", async () => {
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;
    expect(body.karte.followup_question).toBeNull();
  });

  it("Premiumならあと追い質問を返す", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: null,
    });
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;
    expect(body.karte.followup_question).toContain("判別式");
  });

  it("初回カルテで穴が見えたときだけペイウォールを出す", async () => {
    const first = await startSession();
    const firstBody = (await (await complete(first)).json()) as CompleteSessionResponse;
    expect(firstBody.show_paywall).toBe(true);
  });

  it("穴が見つからなかった初回ではペイウォールを出さない", async () => {
    const sessionId = await startSession();
    const body = (await (
      await complete(sessionId, { karte: { ...karteDraft, holes: [] } })
    ).json()) as CompleteSessionResponse;
    expect(body.show_paywall).toBe(false);
  });

  it("進捗は連続日数と埋めた穴だけを返す", async () => {
    const sessionId = await startSession();
    const body = (await (await complete(sessionId)).json()) as CompleteSessionResponse;
    expect(body.progress).toEqual({
      streak_days: 1,
      filled_holes: 0,
      open_holes: 1,
      last_session_date: "2026-08-03",
    });
  });

  it("復習セッションでは対象の穴を埋め、残りの通知を取り消す", async () => {
    // 1日目: 穴ができる
    const first = await startSession();
    const firstBody = (await (await complete(first)).json()) as CompleteSessionResponse;
    const holeId = firstBody.karte.holes[0]?.id;
    expect(holeId).toBeDefined();

    // 復習はPremium機能
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: null,
    });

    // 2日目: 復習セッション(写真なしでも kind=review で入る)
    services.now = () => new Date("2026-08-04T13:00:00.000Z");
    const review = await startSession({ kind: "review", hole_id: holeId });
    const reviewBody = (await (
      await complete(review, { karte: { ...karteDraft, holes: [] } })
    ).json()) as CompleteSessionResponse;

    expect(reviewBody.progress.filled_holes).toBe(1);
    expect(reviewBody.progress.open_holes).toBe(0);
    expect(reviewBody.progress.streak_days).toBe(2);
    // 埋まった穴について通知が届くのがいちばん白ける
    expect(services.scheduler.cancelled).toEqual(["os_1", "os_2", "os_3"]);
  });

  it("通知の予約に失敗してもカルテは返す", async () => {
    const sessionId = await startSession();
    services.scheduler.schedule = async () => {
      throw new Error("OneSignal down");
    };
    const response = await complete(sessionId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as CompleteSessionResponse;
    expect(body.karte.holes).toHaveLength(1);
    expect(body.review_schedule).toHaveLength(3);
  });

  it("スキーマに合わない本文は400", async () => {
    const sessionId = await startSession();
    const response = await complete(sessionId, { ended_reason: "gave_up" });
    expect(response.status).toBe(400);
  });
});

// レビュー指摘: agentのタイムアウト再送で、カルテも穴も通知も二重にできていた
describe("再送(冪等性)", () => {
  it("同じセッションを2度completeしても、カルテは1つだけ", async () => {
    const sessionId = await startSession();
    const first = (await (await complete(sessionId)).json()) as CompleteSessionResponse;

    const retry = await complete(sessionId);
    expect(retry.status).toBe(200);
    const second = (await retry.json()) as CompleteSessionResponse;

    expect(second.karte.id).toBe(first.karte.id);
    expect(services.repository.kartes.size).toBe(1);
    expect(services.repository.holes.size).toBe(1);
    // 通知も増えない
    expect(services.scheduler.scheduled).toHaveLength(3);
  });
});

describe("GET /v1/sessions/{id}/result", () => {
  it("カルテができる前は202を返す(アプリは待って聞き直す)", async () => {
    const sessionId = await startSession();
    const response = await app.request(
      `/v1/sessions/${sessionId}/result`,
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    expect(response.status).toBe(202);
  });

  it("できていればカルテと進捗を返す", async () => {
    const sessionId = await startSession();
    await complete(sessionId);

    const response = await app.request(
      `/v1/sessions/${sessionId}/result`,
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as CompleteSessionResponse;
    expect(body.karte.holes).toHaveLength(1);
    expect(body.progress.streak_days).toBe(1);
  });

  it("他人のセッションは見せない", async () => {
    const sessionId = await startSession();
    await complete(sessionId);

    const response = await app.request(
      `/v1/sessions/${sessionId}/result`,
      { headers: { "x-device-id": "11111111-2222-3333-4444-555555555555" } },
      bindings,
    );
    expect(response.status).toBe(404);
  });
});
