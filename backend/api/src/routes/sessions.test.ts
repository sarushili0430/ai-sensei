import type { CreateSessionResponse, StartSessionResponse } from "@ai-sensei/contract";
import {
  createSessionResponseSchema,
  problemTextMaxLength,
  sessionMetadataSchema,
  sessionPhotoParts,
  startSessionResponseSchema,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import { formatProblemText, formatVisibleWork, getPrompt } from "@ai-sensei/prompts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { verifyJwt } from "../lib/livekit.ts";
import {
  JPEG_BYTES,
  RecordingAnalyzer,
  type TestServices,
  analysisFixture,
  analysisFixtureEn,
  concurrencyBarrier,
  createSessionForm,
  problemPhotoFile,
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

function post(form: FormData, headers: Record<string, string> = {}) {
  return app.request(
    "/v1/sessions",
    { method: "POST", body: form, headers: { "x-device-id": testDeviceId, ...headers } },
    bindings,
  );
}

function patchTopics(sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    `/v1/sessions/${sessionId}/topics`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-device-id": testDeviceId,
        ...headers,
      },
    },
    bindings,
  );
}

/**
 * Starts a conversation. This is the only place today's single use is counted,
 * so every slot concern converges on this entrance.
 */
function startSession(
  sessionId: string,
  body: unknown = {},
  headers: Record<string, string> = {},
  env = bindings,
) {
  return app.request(
    `/v1/sessions/${sessionId}/start`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-device-id": testDeviceId,
        ...headers,
      },
    },
    env,
  );
}

/** Read the photo and start the conversation. Token and context tests go through here. */
async function analyzeThenStart(
  form: FormData = createSessionForm(),
  env = bindings,
): Promise<StartSessionResponse> {
  const created = await app.request(
    "/v1/sessions",
    { method: "POST", body: form, headers: { "x-device-id": testDeviceId } },
    env,
  );
  expect(created.status).toBe(201);
  const session = (await created.json()) as CreateSessionResponse;

  const started = await startSession(session.session_id, {}, {}, env);
  expect(started.status).toBe(200);
  return (await started.json()) as StartSessionResponse;
}

/** The conversation context that rides the token to the agent. */
async function metadataOf<T = Record<string, unknown>>(
  started: StartSessionResponse,
  env = bindings,
): Promise<T> {
  const claims = await verifyJwt(started.livekit.token, env.LIVEKIT_API_SECRET);
  return JSON.parse(String(claims?.["metadata"])) as T;
}

async function makePremium(): Promise<void> {
  await services.repository.ensureUser(testDeviceId, new Date());
  await services.repository.setPremium({
    deviceId: testDeviceId,
    isPremium: true,
    expiresAt: null,
    rcAppUserId: "rc_1",
  });
}

describe("POST /v1/sessions", () => {
  it("写真から単元を検出する", async () => {
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.detected_topics.map((topic) => topic.topic_id)).toContain("M2-ZUKEI-ENCHOKU");
  });

  /**
   * Reading a photo alone does not hand over the room key.
   *
   * Holding the key means being able to start any time, so handing out a token
   * here while saying "counted at conversation start" puts the counter on the
   * client. The schema is `strict()`, so accidentally adding it back fails this.
   */
  it("この時点ではLiveKitトークンを渡さない(数えるのは会話の開始)", async () => {
    const body = (await (await post(createSessionForm())).json()) as Record<string, unknown>;

    expect(body["livekit"]).toBeUndefined();
    expect(body["limits"]).toBeUndefined();
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
  });

  it("写真を読んだだけでは、今日の1回を使わない", async () => {
    expect((await post(createSessionForm())).status).toBe(201);

    // Retaking and re-confirming the unit still passes - not a single conversation yet
    expect((await post(createSessionForm())).status).toBe(201);
    expect(await services.repository.countStartedSessionsOnDate(testDeviceId, "2026-08-03")).toBe(
      0,
    );
  });

  it("デバイスIDがなければ401", async () => {
    const response = await app.request(
      "/v1/sessions",
      { method: "POST", body: createSessionForm() },
      bindings,
    );
    expect(response.status).toBe(401);
  });

  /**
   * Anyone who used up today's lessons is stopped *before* the photo is read.
   * Refusing after running the analysis only piles up Vision LLM cost.
   */
  it("今日の授業を使い切っていれば、解析まで進まない", async () => {
    await analyzeThenStart();

    const analyzer = services.analyzer as RecordingAnalyzer;
    const callsBefore = analyzer.calls.length;

    const response = await post(createSessionForm());
    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      error: { code: string; retry_after_seconds: number };
    };
    expect(body.error.code).toBe("free_limit_reached");
    // Return the seconds until tomorrow so we can say "see you tomorrow"
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(analyzer.calls.length).toBe(callsBefore);
  });

  /**
   * Endless analysis-only usage is stopped. The bar (`analysesPerSessionSlot`) is
   * set where ordinary retakes never hit it, and the wording matches the daily cap.
   */
  it("会話を始めないまま解析を繰り返すと、解析側の上限で止まる", async () => {
    for (let count = 0; count < 5; count += 1) {
      expect((await post(createSessionForm())).status).toBe(201);
    }

    const sixth = await post(createSessionForm());
    expect(sixth.status).toBe(402);
    expect(((await sixth.json()) as { error: { code: string } }).error.code).toBe(
      "free_limit_reached",
    );
  });

  it("数学のノートでなければ撮り直しを促す", async () => {
    services = testServices({
      analysis: {
        subject: "other",
        summary: "英語の単語帳が写っている",
        problem_text: "",
        visible_work: [],
        topics: [],
        unreadable: [],
        question_seeds: [],
      },
    });
    const response = await post(createSessionForm());
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "out_of_scope",
    );
  });

  it("単元を1つも特定できなければセッションを作らない", async () => {
    services = testServices({
      analysis: {
        subject: "math",
        summary: "ぼやけていて読み取れない",
        problem_text: "",
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
        subject: "math",
        summary: "円と直線の位置関係",
        problem_text: "",
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

  /**
   * Flutter's MultipartFile sends application/octet-stream unless contentType is
   * given. Passing that claim straight into media_type made the Vision API return
   * 400, so every photo session from the app became a 500.
   */
  it("申告が application/octet-stream でも、中身を見てJPEGとして解析にかける", async () => {
    // We want to see the claim is not passed through, so capture what the analyser got
    let received: string | undefined;
    services = {
      ...testServices(),
      analyzer: {
        async analyze({ notes }) {
          received = notes?.contentType;
          return analysisFixture;
        },
      },
    };

    const form = new FormData();
    form.set(
      sessionPhotoParts.notes,
      new File([JPEG_BYTES], "note", { type: "application/octet-stream" }),
    );
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    const response = await post(form);
    expect(response.status).toBe(201);
    expect(received).toBe("image/jpeg");
  });

  it("画像でないものは422で返す(Vision APIに投げて500にしない)", async () => {
    const form = new FormData();
    form.set(
      "photo",
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "note.pdf", {
        type: "application/pdf",
      }),
    );
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    const response = await post(form);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("photo_unreadable");
  });

  it("読み取れない写真は今日の解析の枠も消費しない", async () => {
    const form = new FormData();
    form.set("photo", new File([new Uint8Array([0, 1, 2, 3])], "note", { type: "image/heic" }));
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));
    expect((await post(form)).status).toBe(422);

    // If the claimed slot was released, the retaken photo goes through
    expect((await post(createSessionForm())).status).toBe(201);
    expect(services.repository.sessions.size).toBe(1);
  });
});

/**
 * This is where uses are counted.
 *
 * Bug report: taking a photo and confirming the unit alone produced "that's it
 * for today". To a student one use means one conversation with the senpai, so
 * claiming the slot moved from analysis (POST /v1/sessions) to conversation start.
 */
describe("POST /v1/sessions/{id}/start", () => {
  async function analyze(form: FormData = createSessionForm()): Promise<CreateSessionResponse> {
    const response = await post(form);
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  it("会話を始めたときに、部屋の鍵と上限を返す", async () => {
    const session = await analyze();

    const response = await startSession(session.session_id);
    expect(response.status).toBe(200);

    const body = (await response.json()) as StartSessionResponse;
    expect(startSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.session_id).toBe(session.session_id);
    expect(body.livekit.room).toBe(session.session_id);
    expect(body.limits.max_seconds).toBe(1200);
  });

  it("LiveKitトークンに会話の文脈(許可トピック)を載せる", async () => {
    const started = await analyzeThenStart();

    const metadata = await metadataOf<{ allowed_topic_ids: string[]; max_seconds: number }>(
      started,
    );
    expect(metadata.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
    // Digging down to prerequisite topics is allowed
    expect(metadata.allowed_topic_ids).toContain("M1-NIJI-HANBETSU");
    expect(metadata.max_seconds).toBe(1200);
  });

  // With a named worker, nobody joins the room unless the token dispatches
  it("LIVEKIT_AGENT_NAMEがあれば、トークンで先輩を呼ぶ", async () => {
    const named = testBindings({ LIVEKIT_AGENT_NAME: "ai-sensei-senpai" });
    const started = await analyzeThenStart(createSessionForm(), named);

    const claims = await verifyJwt(started.livekit.token, named.LIVEKIT_API_SECRET);
    const roomConfig = claims?.["roomConfig"] as { agents: { agent_name: string }[] } | undefined;
    expect(roomConfig?.agents[0]?.agent_name).toBe("ai-sensei-senpai");
    // The context rides the job too (so the agent can read it without waiting for the participant)
    const dispatched = JSON.parse(
      String((roomConfig?.agents[0] as { metadata?: string } | undefined)?.metadata),
    ) as { allowed_topic_ids: string[] };
    expect(dispatched.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
  });

  it("LIVEKIT_AGENT_NAMEが空なら自動ディスパッチに任せる", async () => {
    const started = await analyzeThenStart();
    const claims = await verifyJwt(started.livekit.token, bindings.LIVEKIT_API_SECRET);
    expect(claims?.["roomConfig"]).toBeUndefined();
  });

  // The free tier is counted server-side (against client tampering)
  it("無料ユーザーは1日1回しか会話を始められない", async () => {
    const first = await analyze();
    const second = await analyze();

    expect((await startSession(first.session_id)).status).toBe(200);

    // The second one cannot start a conversation even though analysis finished
    const response = await startSession(second.session_id);
    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      error: { code: string; retry_after_seconds: number };
    };
    expect(body.error.code).toBe("free_limit_reached");
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
  });

  /**
   * Reconnecting or pressing again must not consume a slot.
   * Loosen this and one retry in bad reception ends today's lesson.
   */
  it("同じセッションを始め直しても、二重に数えない", async () => {
    const session = await analyze();

    const first = await startSession(session.session_id);
    const again = await startSession(session.session_id);

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await services.repository.countStartedSessionsOnDate(testDeviceId, "2026-08-03")).toBe(
      1,
    );
  });

  it("Premiumは通常利用の2回目まで通り、無料と同じ20分を使える", async () => {
    await makePremium();

    await analyzeThenStart();
    const second = await analyzeThenStart();

    expect(second.limits.max_seconds).toBe(1200);
    expect(second.limits.lesson_allowed_today).toBe(true);
  });

  it("Premiumは3回を使ったあとの4回目をフェアユースとして止める", async () => {
    await makePremium();

    // All four finish analysis before starting. Photographing later would stop at the
    // analysis-side pre-check and would not exercise this entrance's cap.
    const ids: string[] = [];
    for (let count = 0; count < 4; count += 1) ids.push((await analyze()).session_id);
    for (const id of ids.slice(0, 3)) {
      expect((await startSession(id)).status).toBe(200);
    }

    const response = await startSession(ids[3] as string);
    expect(response.status).toBe(429);
    const body = (await response.json()) as {
      error: { code: string; message: string; retry_after_seconds: number };
    };
    expect(body.error.code).toBe("fair_use_limit_reached");
    expect(body.error.message).not.toMatch(/[0-9０-９]/);
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
  });

  it("他人のセッションは始められない", async () => {
    const session = await analyze();

    const response = await startSession(
      session.session_id,
      {},
      { "x-device-id": "99999999-8888-7777-6666-555555555555" },
    );
    expect(response.status).toBe(404);
  });

  it("終わったセッションは始め直せない", async () => {
    const session = await analyze();
    await services.repository.completeSession({
      sessionId: session.session_id,
      completedAt: new Date().toISOString(),
      durationSeconds: 300,
    });

    expect((await startSession(session.session_id)).status).toBe(404);
  });

  // The entitlement is checked at creation too, but it can expire in between.
  // Metered cost starts at this entrance, so check again.
  it("復習は、始めるときにもPremiumを確かめる", async () => {
    await makePremium();
    await services.repository.insertKarte(
      {
        id: "kar_seed",
        session_id: "ses_seed",
        device_id: testDeviceId,
        created_at: "2026-08-01T11:00:00.000Z",
        topic_ids: ["M1-NIJI-GURAFU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_seed",
          device_id: testDeviceId,
          karte_id: "kar_seed",
          topic_id: "M1-NIJI-GURAFU",
          desc: "平方完成のなぜで説明が止まった",
          severity: "high",
          evidence: null,
          quiz: null,
          status: "open",
          created_at: "2026-08-01T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );

    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "ja", hole_id: "hol_seed" }));
    const session = (await (await post(form)).json()) as CreateSessionResponse;

    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: false,
      expiresAt: null,
      rcAppUserId: "rc_1",
    });

    const response = await startSession(session.session_id);
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "premium_required",
    );
  });

  it("知らないセッションは404", async () => {
    expect((await startSession("ses_unknown")).status).toBe(404);
  });

  /**
   * The reissue window lasts only as long as the first key.
   *
   * Leave it open and a session opened without ever entering the room becomes a
   * voucher for a key with no expiry. That session was counted on day one, so
   * pressing that id tomorrow adds a lesson without spending today's slot
   * (without a conversation `/complete` never arrives, so the row stays open).
   */
  it("上限時間を過ぎたセッションは、始め直せない", async () => {
    const session = await analyze();
    expect((await startSession(session.session_id)).status).toBe(200);

    // Press again past the conversation cap (20 min) plus grace (2 min)
    services.now = () => new Date("2026-08-03T13:50:07.000Z");

    const response = await startSession(session.session_id);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "session_not_found",
    );
  });

  it("窓の内側なら、同じ会話につなぎ直せる", async () => {
    const session = await analyze();
    expect((await startSession(session.session_id)).status).toBe(200);

    // 16 minutes in. Still the same conversation, so the key reissues and no slot is added.
    services.now = () => new Date("2026-08-03T13:40:07.000Z");

    expect((await startSession(session.session_id)).status).toBe(200);
    expect(await services.repository.countStartedSessionsOnDate(testDeviceId, "2026-08-03")).toBe(
      1,
    );
  });
});

// From review: voice review sessions are Premium, yet passing hole_id directly let free users through
describe("復習セッション", () => {
  async function seedHole(deviceId = testDeviceId): Promise<string> {
    await services.repository.insertKarte(
      {
        id: "kar_seed",
        session_id: "ses_seed",
        device_id: deviceId,
        created_at: "2026-08-01T11:00:00.000Z",
        topic_ids: ["M1-NIJI-GURAFU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_seed",
          device_id: deviceId,
          karte_id: "kar_seed",
          topic_id: "M1-NIJI-GURAFU",
          desc: "平方完成のなぜで説明が止まった",
          severity: "high",
          evidence: "形をそろえるため、だと思う",
          quiz: null,
          status: "open",
          created_at: "2026-08-01T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );
    return "hol_seed";
  }

  function reviewForm(holeId: string): FormData {
    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "ja", hole_id: holeId }));
    return form;
  }

  it("無料ユーザーは小テストを使えても、声で聞き直す授業は始められない", async () => {
    const holeId = await seedHole();
    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "premium_required",
    );
  });

  it("Premiumも写真なしで復習セッションを始められる", async () => {
    await makePremium();
    const holeId = await seedHole();

    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(body.kind).toBe("review");
    // Even with no photo, the unit comes from the hole
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-GURAFU"]);

    const started = await analyzeThenStart(reviewForm(holeId));
    const metadata = await metadataOf<{ problem_text: string; review_hole: unknown }>(started);
    // The hole is not disguised as problem text. "No photo" and the basis for reteaching ride separate fields.
    expect(metadata.problem_text).toBe("(問題の写真なし)");
    expect(metadata.review_hole).toEqual({
      topic_id: "M1-NIJI-GURAFU",
      desc: "平方完成のなぜで説明が止まった",
      evidence: "形をそろえるため、だと思う",
    });
  });

  it("他人の穴IDでは始められない", async () => {
    await makePremium();
    const holeId = await seedHole("99999999-8888-7777-6666-555555555555");

    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(404);
  });

  /**
   * Reviewing a hole recorded in Japanese after switching the device to English.
   * The hole description and unit name are Japanese, so the conversation starts in
   * the hole's curriculum language. The display language (error text) stays the
   * app's.
   */
  it("会話の言語は端末の設定ではなく、穴の課程で決まる", async () => {
    await makePremium();
    const holeId = await seedHole();

    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "en", hole_id: holeId }));

    const started = await analyzeThenStart(form);
    const metadata = await metadataOf<{ locale: string; photo_summary: string }>(started);

    expect(metadata.locale).toBe("ja");
    expect(metadata.photo_summary).toBe("前回、平方完成のなぜで説明が止まった");
  });

  it("表示言語(エラー文言)はアプリの設定に従う", async () => {
    const holeId = await seedHole();

    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "en", hole_id: holeId }));

    const response = await post(form);
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

/**
 * Grounding the problem text (plan §0 decision 4, "send the problem and the notes
 * together").
 *
 * If this is empty when the lesson starts, the senpai teaches without seeing the
 * problem itself - the sore spot of §1-1, "the more an app is built around AI
 * understanding, the more fatal a misreading is".
 */
describe("問題文", () => {
  /** Analysis only. Tests for whether the problem text is returned to the app go here. */
  async function start(options: { problemPhoto?: File } = {}) {
    const response = await post(createSessionForm({}, options));
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  /** Continues to the conversation. Tests for whether the problem text reaches the senpai go here. */
  function problemTextOf(form: FormData = createSessionForm()) {
    return analyzeThenStart(form).then((started) => metadataOf<{ problem_text: string }>(started));
  }

  it("解析が読み取った問題文を、エージェントに渡す文脈に載せる", async () => {
    const metadata = await problemTextOf();
    expect(metadata.problem_text).toBe(analysisFixture.problem_text);
    // The summary (what is in the picture) is not reused as the problem text. This was the original bug.
    expect(metadata.problem_text).not.toBe(analysisFixture.summary);
  });

  it("問題文をアプリにも返す(授業が始まる前に誤読を見せる)", async () => {
    const body = await start();
    expect(body.problem).toEqual({
      text: analysisFixture.problem_text,
      source: "notes_photo",
    });
  });

  // §4-1 "do not require two photos". Often both fit in one.
  it("問題の写真が無くてもセッションは成立する", async () => {
    const body = await start();
    expect(body.session_id).toBeTruthy();
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: false },
    ]);
  });

  it("問題の写真を送ると、1回の解析に2枚まとめて渡す", async () => {
    const body = await start({ problemPhoto: problemPhotoFile() });
    // Two calls double the Vision bill and stop the analyser cross-referencing the pair
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: true },
    ]);
    expect(body.problem?.source).toBe("problem_photo");
  });

  /**
   * Handling of copyrighted work (settling §4-1 / §10-4 as "discard after
   * analysis"). Textbook and workbook pages are not kept in R2. Their absence is
   * checked by count.
   */
  it("問題の写真はR2に保存しない(ノートだけが残る)", async () => {
    const body = await start({ problemPhoto: problemPhotoFile() });
    const stored = [
      ...(bindings.PHOTOS as unknown as { objects: Map<string, unknown> }).objects.keys(),
    ];

    // For this session, R2 holds exactly one object: the notes.
    // A page kept under another key would make this two.
    expect(stored.filter((key) => key.endsWith(body.session_id))).toEqual([
      `photos/${testDeviceId}/${body.session_id}`,
    ]);
  });

  /**
   * Failing the session because only the second photo is unreadable would make a
   * supposedly optional photo effectively required, breaking "do not require two
   * photos" from the API side.
   */
  it("問題の写真が壊れていても、ノートだけで進む", async () => {
    const form = createSessionForm();
    form.set(
      sessionPhotoParts.problem,
      new File([new Uint8Array([0, 1, 2, 3])], "p", { type: "image/heic" }),
    );

    const response = await post(form);
    expect(response.status).toBe(201);
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: false },
    ]);
  });

  // The lesson starts even if the problem is unreadable - but the senpai must be told there is none.
  it("読み取れなければ null を返し、先輩には写真なしと伝える", async () => {
    services = testServices({ analysis: { ...analysisFixture, problem_text: "" } });
    const body = await start();

    expect(body.problem).toBeNull();
    expect((await problemTextOf()).problem_text).toBe("(問題の写真なし)");
  });

  /**
   * This placeholder is named explicitly by `prompts/senpai_board.*.md`.
   * Drift and the instruction "do not reconstruct the problem text by guessing"
   * never fires - and then the senpai starts teaching a problem it invented.
   *
   * The wording's source of truth moved to `formatProblemText()` in
   * `@ai-sensei/prompts`. `packages/prompts` has the same check, but this one
   * watches a different failure: if the API rebuilds the wording without going
   * through the source, that side stays green and this one fails.
   */
  it("プレースホルダが、先輩のプロンプトが見ている文言と一致する", () => {
    expect(getPrompt("senpai_board", "ja").body).toContain(formatProblemText(null, "ja"));
    expect(getPrompt("senpai_board", "en").body).toContain(formatProblemText(null, "en"));
  });

  it("英語のセッションには英語のプレースホルダを渡す", async () => {
    services = {
      ...testServices(),
      analyzer: new RecordingAnalyzer({ ...analysisFixtureEn, problem_text: "" }, {}),
    };
    const metadata = await problemTextOf(createSessionForm({ locale: "en" }));

    expect(metadata.problem_text).toBe("(no photo of the problem)");
  });

  /**
   * Exceeding the cap means the whole page was transcribed. Truncating would teach
   * a problem cut mid-question, and the chapter's answers are likely mixed in.
   */
  it("紙面を丸ごと書き起こした問題文は、切らずに捨てる", async () => {
    services = testServices({
      analysis: { ...analysisFixture, problem_text: "あ".repeat(problemTextMaxLength + 1) },
    });
    const body = await start();

    expect(body.problem).toBeNull();
    expect((await problemTextOf()).problem_text).toBe("(問題の写真なし)");
  });

  /**
   * Confirms `checkProblemText()` from `@ai-sensei/guardrail` is wired where it
   * reaches from the route. Passing text with the answer mixed in makes the senpai
   * copy the answer instead of building the method, degrading the board into an
   * answer display.
   *
   * A rejection does not stop the session: the senpai opens with "could you read
   * the problem out?".
   */
  it("解答が混ざった問題文は先輩に渡さない(セッションは止めない)", async () => {
    services = testServices({
      analysis: {
        ...analysisFixture,
        problem_text: "x^2 - 3x + 2 = 0 を解け。 【解答】x = 1, 2",
      },
    });
    const body = await start();

    expect(body.problem).toBeNull();
    expect((await problemTextOf()).problem_text).toBe(formatProblemText(null, "ja"));
  });

  // If narrowing the unit erased the problem text, we would be back to a senpai teaching without seeing it.
  it("単元を絞り込んでも問題文は残る", async () => {
    const session = await start({ problemPhoto: problemPhotoFile() });

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.problem).toEqual(session.problem);

    const started = (
      await startSession(session.session_id)
    ).json() as Promise<StartSessionResponse>;
    const metadata = await metadataOf<{ problem_text: string }>(await started);
    expect(metadata.problem_text).toBe(analysisFixture.problem_text);
  });

  it("エージェントに渡す文脈は contract のスキーマを満たす", async () => {
    const started = await analyzeThenStart();
    const claims = await verifyJwt(started.livekit.token, bindings.LIVEKIT_API_SECRET);
    const parsed = sessionMetadataSchema.safeParse(JSON.parse(String(claims?.["metadata"])));
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});

/**
 * The path for a student with no notes.
 *
 * Back when notes were mandatory, such a student had no route but to put the
 * printed page in the `photo` (notes) slot, so someone else's copyrighted work
 * ended up stored in R2. The only way to keep the discard promise was to remove
 * the motive for putting a page in the notes slot, so notes stopped being
 * required (§4-1 / §10-4).
 */
describe("問題だけのセッション", () => {
  function problemOnlyForm(meta: Record<string, unknown> = {}): FormData {
    const form = new FormData();
    form.set(sessionPhotoParts.problem, problemPhotoFile());
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja", ...meta }));
    return form;
  }

  /** Continues to the conversation and reads the context that reaches the senpai. */
  function contextOf(form: FormData) {
    return analyzeThenStart(form).then((started) =>
      metadataOf<{ problem_text: string; visible_work: string }>(started),
    );
  }

  it("ノートが無くてもセッションが始まる", async () => {
    const response = await post(problemOnlyForm());
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.problem?.source).toBe("problem_photo");
  });

  // The discard promise itself. With no notes, nothing at all is added to R2.
  it("紙面はR2に保存されない(バケツが空のまま)", async () => {
    // The module-shared bindings hold photos other tests stored (and session_id
    // restarts from ses_1), so check with an isolated empty bucket here.
    const isolated = testBindings();
    const response = await app.request(
      "/v1/sessions",
      { method: "POST", body: problemOnlyForm(), headers: { "x-device-id": testDeviceId } },
      isolated,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateSessionResponse;

    const objects = (isolated.PHOTOS as unknown as { objects: Map<string, unknown> }).objects;
    expect([...objects.keys()]).toEqual([]);

    const session = await services.repository.getSession(body.session_id);
    expect(session?.photo_key).toBeNull();
  });

  it("解析器にはノート無しで渡す(紙面をノートとして解析させない)", async () => {
    await post(problemOnlyForm());
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: false, hadProblem: true },
    ]);
  });

  /**
   * "Took notes but they are blank" and "took no notes" are different things.
   * Conflated, the senpai starts hunting for "where they got stuck" in a student
   * who has not started.
   */
  it("student_work は「(なし)」ではなく「ノートの写真なし」になる", async () => {
    services = testServices({ analysis: { ...analysisFixture, visible_work: [] } });

    const metadata = await contextOf(problemOnlyForm());
    expect(metadata.visible_work).toBe("(ノートの写真なし)");
    expect(metadata.visible_work).not.toBe("(なし)");
  });

  it("英語のセッションには英語の文言を渡す", async () => {
    services = {
      ...testServices(),
      analyzer: new RecordingAnalyzer({ ...analysisFixtureEn, visible_work: [] }, {}),
    };
    const metadata = await contextOf(problemOnlyForm({ locale: "en" }));

    // The wording's source is formatVisibleWork in `@ai-sensei/prompts` (named by the
    // prompt). Pin that the API does not rebuild it, by comparing against the source.
    expect(metadata.visible_work).toBe(formatVisibleWork(null, "en"));
    expect(metadata.visible_work).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  // Narrowing the unit does not make notes exist (photos are not re-analysed).
  it("単元を絞り込んでも、ノート無しの文言のまま", async () => {
    services = testServices({ analysis: { ...analysisFixture, visible_work: [] } });
    const created = await post(problemOnlyForm());
    const session = (await created.json()) as CreateSessionResponse;

    expect(
      (await patchTopics(session.session_id, { topic_ids: ["M2-ZUKEI-ENCHOKU"] })).status,
    ).toBe(200);

    const started = (await (await startSession(session.session_id)).json()) as StartSessionResponse;
    const metadata = await metadataOf<{ visible_work: string }>(started);
    expect(metadata.visible_work).toBe("(ノートの写真なし)");
  });

  /**
   * The same treatment as `problem_text`'s placeholder. The prompt branches on
   * "if this says '(no notes photo)' there are no clues", so one character of
   * drift stops that branch firing and the senpai asks a student with no notes to
   * show their notes.
   */
  it("ノート無しの文言が、先輩のプロンプトが見ている文言と一致する", () => {
    for (const id of ["senpai_board", "senpai_conversation"] as const) {
      expect(getPrompt(id, "ja").body, id).toContain(formatVisibleWork(null, "ja"));
      expect(getPrompt(id, "en").body, id).toContain(formatVisibleWork(null, "en"));
    }
  });

  it("ノートがあるときは、従来どおり読み取った内容を渡す", async () => {
    const metadata = await contextOf(createSessionForm());
    expect(metadata.visible_work).toContain(analysisFixture.visible_work[0]);
  });

  // Loosen this and a session can start with zero photos, so the analyser invents a unit.
  it("どちらの写真も無ければ、従来どおり弾く", async () => {
    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    const response = await post(form);
    expect(response.status).toBe(422);
    expect(services.repository.sessions.size).toBe(0);
  });

  it("紙面が壊れていて、ノートも無ければ弾く(読めた写真がゼロ)", async () => {
    const form = new FormData();
    form.set(
      sessionPhotoParts.problem,
      new File([new Uint8Array([0, 1, 2, 3])], "p", { type: "image/heic" }),
    );
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    expect((await post(form)).status).toBe(422);
    // An unreadable photo must not cost an analysis slot (the existing promise)
    expect((await post(createSessionForm())).status).toBe(201);
  });

  /**
   * Reviews use no photo and take the previous hole as context, so writing "no
   * notes photo" here would report an absence that does not exist.
   */
  it("復習セッションの student_work は変わらない", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: null,
    });
    await services.repository.insertKarte(
      {
        id: "kar_seed",
        session_id: "ses_seed",
        device_id: testDeviceId,
        created_at: "2026-08-01T11:00:00.000Z",
        topic_ids: ["M1-NIJI-GURAFU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_seed",
          device_id: testDeviceId,
          karte_id: "kar_seed",
          topic_id: "M1-NIJI-GURAFU",
          desc: "平方完成のなぜで説明が止まった",
          severity: "high",
          evidence: null,
          quiz: null,
          status: "open",
          created_at: "2026-08-01T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );

    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "ja", hole_id: "hol_seed" }));

    const metadata = await contextOf(form);
    expect(metadata.visible_work).toBe("(なし)");
  });
});

describe("検出単元の確信度", () => {
  it("解析器が返した確信度をそのまま渡す", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;

    const primary = body.detected_topics.find((t) => t.topic_id === "M2-ZUKEI-ENCHOKU");
    expect(primary?.confidence).toBe(0.92);
  });
});

// From review: with the cap check separated from row creation, concurrent posts both pass
describe("解析枠の押さえ方", () => {
  it("解析に失敗したら、その日の解析の枠を消費しない", async () => {
    services = testServices({
      analysis: {
        subject: "other",
        summary: "英語の単語帳",
        problem_text: "",
        visible_work: [],
        topics: [],
        unreadable: [],
        question_seeds: [],
      },
    });
    expect((await post(createSessionForm())).status).toBe(422);
    expect(services.repository.sessions.size).toBe(0);

    // Retaking still allows a start later the same day
    services.analyzer = testServices().analyzer;
    expect((await post(createSessionForm())).status).toBe(201);
  });

  it("解析の前に行を作って解析の枠を押さえる", async () => {
    let sessionsDuringAnalysis = -1;
    services.analyzer = {
      async analyze() {
        sessionsDuringAnalysis = services.repository.sessions.size;
        return analysisFixture;
      },
    };

    await post(createSessionForm());
    // A row already exists during analysis = concurrent analyses count the same slot
    expect(sessionsDuringAnalysis).toBe(1);
  });
});

/**
 * Atomicity of the lesson slot. Claiming moved to conversation start, so the
 * concurrency hole moved there too.
 *
 * Line up as many analysed sessions as there are people, then start them all at
 * once. Revert to a "count, then write" implementation and everyone sees the same
 * "still room" and passes.
 */
describe("同時実行の授業枠", () => {
  async function analyzed(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const response = await post(createSessionForm());
      expect(response.status).toBe(201);
      ids.push(((await response.json()) as CreateSessionResponse).session_id);
    }
    return ids;
  }

  /** A barrier that lines everyone up where `/start` has passed `ensureUser`. */
  function lineUpAt(count: number): void {
    const wait = concurrencyBarrier(count);
    const repository = services.repository;
    const original = repository.ensureUser.bind(repository);
    repository.ensureUser = async (deviceId: string, now: Date) => {
      const user = await original(deviceId, now);
      await wait();
      return user;
    };
  }

  it("無料は同時に3本始めても1本しか通らない", async () => {
    const ids = await analyzed(3);
    lineUpAt(3);

    const responses = await Promise.all(ids.map((id) => startSession(id)));
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
      200, 402, 402,
    ]);

    const rejected = responses.filter((response) => response.status === 402);
    const errors = await Promise.all(
      rejected.map((response) => response.json() as Promise<{ error: { code: string } }>),
    );
    expect(errors.map((body) => body.error.code)).toEqual([
      "free_limit_reached",
      "free_limit_reached",
    ]);
    expect(await services.repository.countStartedSessionsOnDate(testDeviceId, "2026-08-03")).toBe(
      1,
    );
  });

  it("Premiumは同時に5本始めても3本しか通らない", async () => {
    await makePremium();
    const ids = await analyzed(5);
    lineUpAt(5);

    const responses = await Promise.all(ids.map((id) => startSession(id)));
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
      200, 200, 200, 429, 429,
    ]);

    const rejected = responses.filter((response) => response.status === 429);
    const errors = await Promise.all(
      rejected.map((response) => response.json() as Promise<{ error: { code: string } }>),
    );
    expect(errors.map((body) => body.error.code)).toEqual([
      "fair_use_limit_reached",
      "fair_use_limit_reached",
    ]);
    expect(await services.repository.countStartedSessionsOnDate(testDeviceId, "2026-08-03")).toBe(
      3,
    );
  });
});

/**
 * Bug report: photo -> pick subject -> start conversation gave "that's it for
 * today". Confirming the unit recreated the session, consuming the free tier twice.
 */
describe("PATCH /v1/sessions/{id}/topics", () => {
  async function analyze(): Promise<CreateSessionResponse> {
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  it("単元を絞っても、セッションは作り直さない", async () => {
    const session = await analyze();

    const response = await patchTopics(session.session_id, {
      locale: "ja",
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    // Still the same session. No extra row means neither analysis nor slot is doubled
    expect(body.session_id).toBe(session.session_id);
    expect(services.repository.sessions.size).toBe(1);
  });

  // Someone who only confirmed the unit has not had a conversation yet.
  it("単元を確かめただけでは、今日の1回を使わない", async () => {
    const session = await analyze();
    await patchTopics(session.session_id, { topic_ids: ["M2-ZUKEI-ENCHOKU"] });

    expect(await services.repository.countStartedSessionsOnDate(testDeviceId, "2026-08-03")).toBe(
      0,
    );
    const progress = await app.request(
      "/v1/me/progress",
      { headers: { "x-device-id": testDeviceId } },
      bindings,
    );
    const body = (await progress.json()) as { limits: { lesson_allowed_today: boolean } };
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  it("外した単元は、始めるときのトークンにも載らない", async () => {
    const session = await analyze();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M1-NIJI-HANBETSU"],
    });
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-HANBETSU"]);

    const started = (await (await startSession(session.session_id)).json()) as StartSessionResponse;
    const metadata = await metadataOf<{ allowed_topic_ids: string[]; photo_summary: string }>(
      started,
    );
    expect(metadata.allowed_topic_ids).not.toContain("M2-ZUKEI-ENCHOKU");
    // The conversation context survives without re-analysing the photo
    expect(metadata.photo_summary).toBe(analysisFixture.summary);
  });

  it("解析時の確信度をそのまま返す(チップの見た目が変わらない)", async () => {
    const session = await analyze();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics[0]?.confidence).toBe(0.92);
  });

  it("検出していない単元には差し替えられない", async () => {
    const session = await analyze();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M1-NIJI-GURAFU"],
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "photo_unreadable",
    );
  });

  it("他人のセッションは触れない", async () => {
    const session = await analyze();

    const response = await patchTopics(
      session.session_id,
      { topic_ids: ["M2-ZUKEI-ENCHOKU"] },
      { "x-device-id": "99999999-8888-7777-6666-555555555555" },
    );
    expect(response.status).toBe(404);
  });

  it("終わったセッションは触れない", async () => {
    const session = await analyze();
    await services.repository.completeSession({
      sessionId: session.session_id,
      completedAt: new Date().toISOString(),
      durationSeconds: 300,
    });

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    expect(response.status).toBe(404);
  });

  it("Premiumも会話時間の上限は20分のまま", async () => {
    await makePremium();
    const session = await analyze();

    expect(
      (await patchTopics(session.session_id, { topic_ids: ["M2-ZUKEI-ENCHOKU"] })).status,
    ).toBe(200);

    const started = (await (await startSession(session.session_id)).json()) as StartSessionResponse;
    expect(started.limits.max_seconds).toBe(1200);
    expect(started.limits.lesson_allowed_today).toBe(true);
  });
});

/**
 * A session started on an overseas curriculum.
 *
 * What matters is not "does it answer in English" but whether the context handed
 * to the conversation stays on the English curriculum end to end. Mixed, the
 * agent would speak English while drawing guardrails from Japanese unit names.
 */
describe("locale=en のセッション", () => {
  let analyzer: RecordingAnalyzer;

  beforeEach(() => {
    analyzer = new RecordingAnalyzer();
    services = { ...testServices(), analyzer };
  });

  it("英語の課程で解析し、英語の科目名をチップに返す", async () => {
    const response = await post(createSessionForm({ locale: "en" }));
    expect(response.status).toBe(201);

    expect(analyzer.calls).toEqual([{ locale: "en", hadNotes: true, hadProblem: false }]);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.detected_topics.map((topic) => topic.topic_id)).toContain("A2-COORD-CIRCLE");
    expect(body.detected_topics.map((topic) => topic.course)).toContain("Algebra 2");
  });

  it("エージェントに渡す文脈も英語で揃える", async () => {
    const started = await analyzeThenStart(createSessionForm({ locale: "en" }));
    const metadata = await metadataOf<{
      locale: string;
      allowed_topics: string;
      allowed_topic_ids: string[];
      question_seeds: string;
    }>(started);

    expect(metadata.locale).toBe("en");
    expect(metadata.allowed_topics).toContain("Algebra 2 / Coordinate Geometry");
    expect(metadata.allowed_topics).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    for (const id of metadata.allowed_topic_ids) {
      expect(localeOfTopicId(id), id).toBe("en");
    }
  });

  it("エラー文言も英語で返す", async () => {
    await analyzeThenStart(createSessionForm({ locale: "en" }));
    const response = await post(createSessionForm({ locale: "en" }));

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("free_limit_reached");
    expect(body.error.message).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it("単元を絞り込んでも英語の課程のまま", async () => {
    const created = await post(createSessionForm({ locale: "en" }));
    const session = (await created.json()) as CreateSessionResponse;

    const response = await patchTopics(session.session_id, {
      locale: "en",
      topic_ids: ["A2-COORD-CIRCLE"],
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["A2-COORD-CIRCLE"]);

    const started = (await (await startSession(session.session_id)).json()) as StartSessionResponse;
    const metadata = await metadataOf<{ locale: string }>(started);
    expect(metadata.locale).toBe("en");
  });
});
