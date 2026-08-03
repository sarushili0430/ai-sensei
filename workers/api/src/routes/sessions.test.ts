import type { CreateSessionResponse } from "@ai-sensei/contract";
import { createSessionResponseSchema } from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { verifyJwt } from "../lib/livekit.ts";
import {
  createSessionForm,
  testBindings,
  testDeviceId,
  testServices,
  type TestServices,
} from "../test-support.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

function post(form: FormData, headers: Record<string, string> = {}) {
  return app.request(
    "/v1/sessions",
    { method: "POST", body: form, headers: { "x-device-id": testDeviceId, ...headers } },
    bindings,
  );
}

describe("POST /v1/sessions", () => {
  it("写真から単元を検出し、LiveKitトークンを返す", async () => {
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.detected_topics.map((topic) => topic.topic_id)).toContain("M2-ZUKEI-ENCHOKU");
    expect(body.livekit.room).toBe(body.session_id);
  });

  it("LiveKitトークンに会話の文脈(許可トピック)を載せる", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    expect(claims).not.toBeNull();
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      allowed_topic_ids: string[];
      max_seconds: number;
    };
    expect(metadata.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
    // 前提トピックまで深掘りを許す
    expect(metadata.allowed_topic_ids).toContain("M1-NIJI-HANBETSU");
    expect(metadata.max_seconds).toBe(300);
  });

  it("デバイスIDがなければ401", async () => {
    const response = await app.request(
      "/v1/sessions",
      { method: "POST", body: createSessionForm() },
      bindings,
    );
    expect(response.status).toBe(401);
  });

  // 無料枠はサーバ側で数える(クライアント改竄対策)
  it("無料ユーザーは1日1セッションまで", async () => {
    expect((await post(createSessionForm())).status).toBe(201);

    const second = await post(createSessionForm());
    expect(second.status).toBe(402);
    const body = (await second.json()) as { error: { code: string; retry_after_seconds: number } };
    expect(body.error.code).toBe("free_limit_reached");
    // 「また明日」と言えるように、翌日までの秒数を返す
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
  });

  it("Premiumは制限にかからず、会話時間の上限も長い", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: "rc_1",
    });

    await post(createSessionForm());
    const second = await post(createSessionForm());
    expect(second.status).toBe(201);

    const body = (await second.json()) as CreateSessionResponse;
    expect(body.limits.max_seconds).toBe(900);
    expect(body.limits.remaining_sessions_today).toBeNull();
  });

  it("数学のノートでなければ撮り直しを促す", async () => {
    services = testServices({
      analysis: {
        is_math_note: false,
        summary: "英語の単語帳が写っている",
        visible_work: [],
        topics: [],
        unreadable: [],
        question_seeds: [],
      },
    });
    const response = await post(createSessionForm());
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("out_of_scope");
  });

  it("単元を1つも特定できなければセッションを作らない", async () => {
    services = testServices({
      analysis: {
        is_math_note: true,
        summary: "ぼやけていて読み取れない",
        visible_work: [],
        topics: [],
        unreadable: ["全体的に暗い"],
        question_seeds: [],
      },
    });
    const response = await post(createSessionForm());
    expect(response.status).toBe(422);
    expect(services.repository.sessions.size).toBe(0);
  });

  it("ユーザーがチップUIで直した単元を優先する", async () => {
    const response = await post(createSessionForm({ topic_ids: ["M1-NIJI-GURAFU"] }));
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-GURAFU"]);
  });

  it("LLMが捏造したtopic_idは許可リストに入れない", async () => {
    services = testServices({
      analysis: {
        is_math_note: true,
        summary: "円と直線の位置関係",
        visible_work: [],
        topics: [
          { topic_id: "M2-ZUKEI-ENCHOKU", confidence: 0.9 },
          { topic_id: "MX-SENKEI-DAISU", confidence: 0.8 },
        ],
        unreadable: [],
        question_seeds: [],
      },
    });
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M2-ZUKEI-ENCHOKU"]);
  });

  it("写真をR2に保存する", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;
    const session = await services.repository.getSession(body.session_id);
    expect(session?.photo_key).toBe(`photos/${testDeviceId}/${body.session_id}`);
  });
});
