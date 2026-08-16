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

function patchProblem(sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    `/v1/sessions/${sessionId}/problem`,
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
 * 会話を始める。**今日の1回を数えるのはここだけ**なので、枠の話は全部この入口に集まる。
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

/** 写真を読ませて、そのまま会話を始める。トークンと文脈を見るテストはここを通る。 */
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

/** トークンに載って agent へ届く会話文脈。 */
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
   * **写真を読んだだけでは部屋の鍵を渡さない。**
   *
   * 鍵を持っている = いつでも会話を始められるので、ここでトークンを配ったまま
   * 「会話の開始で数える」と言っても、数える口をクライアント側に置いたのと同じになる。
   * `strict()` のスキーマなので、うっかり足し戻したらこのテストが落ちる。
   */
  it("この時点ではLiveKitトークンを渡さない(数えるのは会話の開始)", async () => {
    const body = (await (await post(createSessionForm())).json()) as Record<string, unknown>;

    expect(body["livekit"]).toBeUndefined();
    expect(body["limits"]).toBeUndefined();
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
  });

  it("写真を読んだだけでは、今日の1回を使わない", async () => {
    expect((await post(createSessionForm())).status).toBe(201);

    // 撮り直して単元を確かめ直しても、まだ1回も話していないのだから通る
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
   * 今日の授業を使い切った人は、**写真を読む前に**止める。
   * 解析まで走らせてから断ると、Vision LLMの原価だけが積み上がる。
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
    // 「また明日」と言えるように、翌日までの秒数を返す
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(analyzer.calls.length).toBe(callsBefore);
  });

  /**
   * 解析だけを延々と繰り返す使い方は止める。**通常の撮り直しでは当たらない**
   * 高さに置いてあり(`analysesPerSessionSlot`)、当たっても文言は日次上限と同じ。
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
   * Flutterの MultipartFile は contentType を渡さないと
   * application/octet-stream を送ってくる。申告をそのまま media_type にすると
   * Vision APIが400を返し、アプリからの写真つきセッションが全部500になっていた。
   */
  it("申告が application/octet-stream でも、中身を見てJPEGとして解析にかける", async () => {
    // 申告をそのまま渡していないことを見たいので、解析器が受け取った値を捕まえる
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

    // 押さえた枠が返っていれば、撮り直した1枚はちゃんと通る
    expect((await post(createSessionForm())).status).toBe(201);
    expect(services.repository.sessions.size).toBe(1);
  });
});

/**
 * **回数を数えるのはここ。**
 *
 * 不具合報告: 写真を撮って単元を確かめただけで「今日はここまで」になった。
 * 生徒にとっての1回は「先輩と話した回数」なので、枠を押さえる位置を
 * 解析(POST /v1/sessions)から会話の開始へ移した。
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
    // 前提トピックまで深掘りを許す
    expect(metadata.allowed_topic_ids).toContain("M1-NIJI-HANBETSU");
    expect(metadata.max_seconds).toBe(1200);
  });

  // 名前つきワーカーのときは、トークンでディスパッチしないと部屋に誰も来ない
  it("LIVEKIT_AGENT_NAMEがあれば、トークンで先輩を呼ぶ", async () => {
    const named = testBindings({ LIVEKIT_AGENT_NAME: "ai-sensei-senpai" });
    const started = await analyzeThenStart(createSessionForm(), named);

    const claims = await verifyJwt(started.livekit.token, named.LIVEKIT_API_SECRET);
    const roomConfig = claims?.["roomConfig"] as { agents: { agent_name: string }[] } | undefined;
    expect(roomConfig?.agents[0]?.agent_name).toBe("ai-sensei-senpai");
    // 文脈はジョブ側にも載せる(エージェントが参加者を待たずに読めるように)
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

  // 無料枠はサーバ側で数える(クライアント改竄対策)
  it("無料ユーザーは1日1回しか会話を始められない", async () => {
    const first = await analyze();
    const second = await analyze();

    expect((await startSession(first.session_id)).status).toBe(200);

    // 2本目は解析まで済んでいても、会話は始められない
    const response = await startSession(second.session_id);
    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      error: { code: string; retry_after_seconds: number };
    };
    expect(body.error.code).toBe("free_limit_reached");
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
  });

  /**
   * つなぎ直し・押し直しで枠が減らないこと。
   * ここが緩むと、電波の悪い場所で1回押し直しただけで今日の授業が終わる。
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

    // 4本とも先に解析まで済ませてから始める。あとから撮ると、始める前に
    // 解析側の事前判定で止まってしまい、**この入口の上限**を見たことにならない。
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

  // 契約は作成時にも見ているが、そこから期限が切れることがある。
  // 従量原価が動くのはこの入口なので、ここでもう一度見る。
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
   * **押し直しの窓は、最初の鍵の寿命まで。**
   *
   * ここが開いていると、部屋に入らないまま開いたセッションが期限のない
   * 鍵の引換券になる。その1本は最初の日に数えられているので、翌日そのIDで
   * 押せば、今日の枠を減らさずに授業が1回増えてしまう
   * (会話が成立しなければ `/complete` も来ないので、行は open のまま残る)。
   */
  it("上限時間を過ぎたセッションは、始め直せない", async () => {
    const session = await analyze();
    expect((await startSession(session.session_id)).status).toBe(200);

    // 会話の上限(20分)+ 余白(2分)を越えたところで、もう一度押す
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

    // 16分後。まだ同じ会話の途中なので、鍵は出し直せて枠も増えない。
    services.now = () => new Date("2026-08-03T13:40:07.000Z");

    expect((await startSession(session.session_id)).status).toBe(200);
    expect(await services.repository.countStartedSessionsOnDate(testDeviceId, "2026-08-03")).toBe(
      1,
    );
  });
});

// レビュー指摘: 音声の復習セッションはPremiumなのに、hole_idを直接渡せば無料でも通っていた
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
    // 写真がなくても、穴から単元を引く
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-GURAFU"]);
    /**
     * 問題文の決着は `null` = **写真を1枚も読んでいない**。
     * `not_found`(読んだが写っていなかった)に寄せると、撮っていない生徒に
     * 「問題が読めませんでした」と直し方まで出すことになる。
     */
    expect(body.problem).toBeNull();
    expect(body.problem_outcome).toBeNull();

    const started = await analyzeThenStart(reviewForm(holeId));
    const metadata = await metadataOf<{ problem_text: string; review_hole: unknown }>(started);
    // 穴を問題文に偽装しない。写真なしの事実と、教え直す根拠は別の欄で運ぶ。
    expect(metadata.problem_text).toBe("(問題の写真なし)");
    expect(metadata.review_hole).toEqual({
      topic_id: "M1-NIJI-GURAFU",
      desc: "平方完成のなぜで説明が止まった",
      evidence: "形をそろえるため、だと思う",
    });
  });

  /**
   * 復習に問題文の手入力は無い。板書プロンプトは `lesson_mode` が `review` のとき
   * `problem_text` を見ない(「一致するほうの入力だけ」)ので、通しても授業には効かず、
   * 効かない更新に 200 を返す口が増えるだけになる。
   */
  it("復習セッションの問題文は手入力できない", async () => {
    await makePremium();
    const holeId = await seedHole();
    const created = await post(reviewForm(holeId));
    const session = (await created.json()) as CreateSessionResponse;

    const response = await patchProblem(session.session_id, { text: "x を求めよ。" });
    expect(response.status).toBe(404);
  });

  it("他人の穴IDでは始められない", async () => {
    await makePremium();
    const holeId = await seedHole("99999999-8888-7777-6666-555555555555");

    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(404);
  });

  /**
   * 端末を英語に切り替えたあとで、日本語で残した穴を復習する場合。
   * 穴の説明文も単元名も日本語なので、**会話は穴の課程の言語で始める**。
   * 表示言語(エラー文言)はアプリ側のままにする。
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
 * 問題文のグラウンディング(計画書 §0 の決定4「問題とノートをセットで送る」)。
 *
 * ここが空のまま授業が始まると、**先輩は問題そのものを見ないまま教える**。
 * §1-1「AIが理解している建て付けのアプリほど誤読が致命傷になる」の急所。
 */
describe("問題文", () => {
  /** 解析だけ。問題文を「アプリに返すか」を見るテストはこちら。 */
  async function start(options: { problemPhoto?: File } = {}) {
    const response = await post(createSessionForm({}, options));
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  /** 会話まで進める。問題文が「先輩に届くか」を見るテストはこちら。 */
  function problemTextOf(form: FormData = createSessionForm()) {
    return analyzeThenStart(form).then((started) => metadataOf<{ problem_text: string }>(started));
  }

  it("解析が読み取った問題文を、エージェントに渡す文脈に載せる", async () => {
    const metadata = await problemTextOf();
    expect(metadata.problem_text).toBe(analysisFixture.problem_text);
    // 要約(何が写っているか)を問題文として流用しない。これが元の不具合そのもの。
    expect(metadata.problem_text).not.toBe(analysisFixture.summary);
  });

  it("問題文をアプリにも返す(授業が始まる前に誤読を見せる)", async () => {
    const body = await start();
    expect(body.problem).toEqual({
      text: analysisFixture.problem_text,
      source: "notes_photo",
    });
  });

  // §4-1「写真2枚を必須にしない」。1枚に両方写るケースが多い。
  it("問題の写真が無くてもセッションは成立する", async () => {
    const body = await start();
    expect(body.session_id).toBeTruthy();
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: false },
    ]);
  });

  it("問題の写真を送ると、1回の解析に2枚まとめて渡す", async () => {
    const body = await start({ problemPhoto: problemPhotoFile() });
    // 2回叩くとVisionの課金が倍になり、しかも解析器が2枚を突き合わせられない
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: true },
    ]);
    expect(body.problem?.source).toBe("problem_photo");
  });

  /**
   * **著作物の扱い**(§4-1 / §10-4 を「解析後破棄」で決着させたもの)。
   * 教科書・問題集の紙面はR2に残さない。残っていないことを数で見る。
   */
  it("問題の写真はR2に保存しない(ノートだけが残る)", async () => {
    const body = await start({ problemPhoto: problemPhotoFile() });
    const stored = [
      ...(bindings.PHOTOS as unknown as { objects: Map<string, unknown> }).objects.keys(),
    ];

    // このセッションについてR2にあるのは、ノートの1件だけ。
    // 紙面が別キーで残っていれば、ここが2件になる。
    expect(stored.filter((key) => key.endsWith(body.session_id))).toEqual([
      `photos/${testDeviceId}/${body.session_id}`,
    ]);
  });

  /**
   * 2枚目が読めないだけでセッションを落とすと、**任意のはずの写真が事実上の必須**になり、
   * 「2枚必須にしない」がAPIの側から破れる。
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

  // 問題が読めなくても授業は始まる。ただし先輩には「無い」と伝わっていないといけない。
  it("読み取れなければ null を返し、先輩には写真なしと伝える", async () => {
    services = testServices({ analysis: { ...analysisFixture, problem_text: "" } });
    const body = await start();

    expect(body.problem).toBeNull();
    expect((await problemTextOf()).problem_text).toBe("(問題の写真なし)");
  });

  /**
   * このプレースホルダは `prompts/senpai_board.*.md` が名指しで見ている。
   * **ずれると「問題文を推測で組み立てないこと」という指示が発火しない** —
   * 発火しなければ、先輩は自分で作った問題を教えはじめる。
   *
   * 文言の正本は `@ai-sensei/prompts` の `formatProblemText()` に移した。
   * `packages/prompts` 側にも同じ照合があるが、こちらは別の壊れ方を見ている —
   * **API が正本を通さずに文言を組み立て直したら**、あちらは緑のままここが落ちる。
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
   * 上限を超えるのは「紙面を丸ごと書き起こした」とき。先頭で切ると設問の途中で
   * 切れた問題を教えることになり、章末の解答まで混ざっている可能性も高い。
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
   * `@ai-sensei/guardrail` の `checkProblemText()` が**ルートから届く位置に繋がっている**
   * ことの確認。解答が混ざったまま渡すと、先輩は解き方を組み立てずに答えを写し、
   * 板書が「答え合わせの表示器」に劣化する。
   *
   * 落としてもセッションは止めない。先輩は「問題、読んでもらってもいい?」から始まる。
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

  // 単元を絞り込むだけで問題文が消えると、先輩が問題を見ないまま教える状態に戻る。
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
 * **読めなかった理由を、アプリまで届ける。**
 *
 * `problem: null` だけを返していたあいだ、確認画面は読めなかったセッションを
 * 黙って通すしかなく、失敗が最初に表に出るのは会話の中 —
 * 先輩の「問題、読んでもらってもいい?」だった。**画面に問題が見えているのに、
 * 声で言い直させられる**というのが、外部テスターの唯一の不満。
 *
 * 落ち方を畳まないのは、言うべき直し方が落ち方ごとに違うから
 * (`too_long` は「問題の部分だけを撮る」、`solution_included` は「答えを写さない」)。
 */
describe("問題文の落ち方", () => {
  async function create(analysis?: Partial<typeof analysisFixture>) {
    if (analysis) services = testServices({ analysis: { ...analysisFixture, ...analysis } });
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  it("読めたセッションは read を返す", async () => {
    const body = await create();
    expect(body.problem_outcome).toBe("read");
  });

  it.each([
    // 写っていない(解析器が空で返した)
    ["not_found", ""],
    // 紙面を丸ごと書き起こしている。切らずに捨てる
    ["too_long", "あ".repeat(problemTextMaxLength + 1)],
    // 章末の解答まで写り込んでいる(guardrail)
    ["solution_included", "x^2 - 3x + 2 = 0 を解け。 【解答】x = 1, 2"],
    // 式だけで、何を問われているか書かれていない(guardrail)
    ["not_a_problem", "x^2 - 3x + 2 = 0"],
  ])("%s は、その落ち方のまま返る", async (outcome, problemText) => {
    const body = await create({ problem_text: problemText });

    expect(body.problem).toBeNull();
    expect(body.problem_outcome).toBe(outcome);
    // どの落ち方でもセッションは止めない(問題の写真は必須ではない)。
    expect(body.detected_topics.length).toBeGreaterThan(0);
  });

  // ここが落ちると、チップを1つ外した瞬間に画面から直し方が消える
  // (PATCH の時点では写真も解析結果も残っていないので、文脈に残すしかない)。
  it("単元を絞り込んでも、落ち方は残る", async () => {
    const session = await create({ problem_text: "" });

    const response = await patchTopics(session.session_id, { topic_ids: ["M2-ZUKEI-ENCHOKU"] });
    const body = (await response.json()) as CreateSessionResponse;

    expect(body.problem).toBeNull();
    expect(body.problem_outcome).toBe("not_found");
  });

  it("応答は contract のスキーマを満たす(problem と落ち方の対を含む)", async () => {
    const read = createSessionResponseSchema.safeParse(await create());
    expect(read.success ? null : read.error.issues).toBeNull();

    const unread = createSessionResponseSchema.safeParse(await create({ problem_text: "" }));
    expect(unread.success ? null : unread.error.issues).toBeNull();
  });
});

/**
 * PATCH /v1/sessions/{id}/problem — **問題文を、生徒が自分で確定させる口。**
 *
 * 読めなかったときの救済(打てば済む)と、誤読の訂正(会話の頭を1往復使わない)が
 * 同じ入口。写真は読み直さない — 紙面はもう破棄してあり、読み直す手段が無い。
 */
describe("問題文の手入力", () => {
  const typed = "円 x^2 + y^2 = 9 と直線 y = 2x + 1 の共有点の個数を求めよ。";

  async function createUnread() {
    services = testServices({ analysis: { ...analysisFixture, problem_text: "" } });
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  it("打った問題文が、そのまま先輩に届く", async () => {
    const session = await createUnread();

    const response = await patchProblem(session.session_id, { text: typed });
    expect(response.status).toBe(200);
    const body = (await response.json()) as CreateSessionResponse;

    // 写真ではないので、出どころは `typed`。2枚送った率の観測に混ぜない。
    expect(body.problem).toEqual({ text: typed, source: "typed" });
    expect(body.problem_outcome).toBe("read");

    // **ここが本題。** 打った時点で先輩は問題を持っているので、
    // 「問題、読んでもらってもいい?」から始まらない。
    const started = (
      await startSession(session.session_id)
    ).json() as Promise<StartSessionResponse>;
    const metadata = await metadataOf<{ problem_text: string }>(await started);
    expect(metadata.problem_text).toBe(typed);
  });

  // 誤読の訂正。これまでの保険は「ちがっていれば会話の最初に本人が言う」だけだった。
  it("読めていた問題文も上書きできる", async () => {
    const created = await post(createSessionForm());
    const session = (await created.json()) as CreateSessionResponse;
    expect(session.problem?.text).toBe(analysisFixture.problem_text);

    const response = await patchProblem(session.session_id, { text: typed });
    const body = (await response.json()) as CreateSessionResponse;

    expect(body.problem).toEqual({ text: typed, source: "typed" });
  });

  // 単元まで巻き戻すと、絞り込んだ生徒が外した単元を教わることになる。
  it("絞り込んだ単元には触らない", async () => {
    const session = await createUnread();
    await patchTopics(session.session_id, { topic_ids: ["M2-ZUKEI-ENCHOKU"] });

    const response = await patchProblem(session.session_id, { text: typed });
    const body = (await response.json()) as CreateSessionResponse;

    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M2-ZUKEI-ENCHOKU"]);
  });

  /**
   * 解析器の出力に掛けているのと**同じ関門**(`checkProblemText`)を通す。
   * 手入力にだけ厳しくすると、読めなかった生徒が今度は自分の入力で弾かれる。
   */
  it.each([
    ["設問が無い式だけの入力", "x^2 - 3x + 2 = 0"],
    ["解答が混ざった入力", "x^2 - 3x + 2 = 0 を解け。 【解答】x = 1, 2"],
  ])("%s は受け付けない", async (_label, text) => {
    const session = await createUnread();

    const response = await patchProblem(session.session_id, { text });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    // **`photo_unreadable` ではない。** 打った人に「もう一度撮ってみてください」は的外れで、
    // 直せるのは手元のテキストのほう。
    expect(body.error.code).toBe("problem_text_rejected");
  });

  it.each([
    ["空", ""],
    ["空白だけ", "   "],
    ["上限超過", "あ".repeat(problemTextMaxLength + 1)],
  ])("%s の入力は受け付けない", async (_label, text) => {
    const session = await createUnread();

    const response = await patchProblem(session.session_id, { text });
    expect(response.status).toBe(422);
  });

  /**
   * 弾かれる場面(長すぎ・空)は、**まさに文言を読ませたいところ**。
   * `locale` を検証後の値から取ると、打った文が長かっただけで
   * 英語のユーザーに日本語のお願いが返る。
   */
  it("本文が通らなくても、文言は端末の言語で返す", async () => {
    const session = await createUnread();

    const response = await patchProblem(session.session_id, {
      locale: "en",
      text: "あ".repeat(problemTextMaxLength + 1),
    });
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(422);
    expect(body.error.message).toMatch(/didn't read as a question/);
  });

  /**
   * 文脈がエージェントへ渡るのは `/start` の1回きり。始まったあとに受け付けると、
   * 生徒には「直したのに直っていない」に見える — 声で言い直させられるより悪い。
   */
  it("会話が始まったあとは直せない", async () => {
    const session = await createUnread();
    expect((await startSession(session.session_id)).status).toBe(200);

    const response = await patchProblem(session.session_id, { text: typed });
    expect(response.status).toBe(404);
  });

  it("他人のセッションは直せない", async () => {
    const session = await createUnread();

    const response = await patchProblem(
      session.session_id,
      { text: typed },
      { "x-device-id": "99999999-8888-7777-6666-555555555555" },
    );
    expect(response.status).toBe(404);
  });

  // Vision LLMを呼ばないので原価が動かない。ここで数えると、
  // 読めなかった人だけが余分に払うという逆さまの形になる。
  it("今日の授業枠も解析枠も使わない", async () => {
    const session = await createUnread();
    await patchProblem(session.session_id, { text: typed });

    const started = await startSession(session.session_id);
    expect(started.status).toBe(200);
  });

  it("応答は contract のスキーマを満たす", async () => {
    const session = await createUnread();
    const response = await patchProblem(session.session_id, { text: typed });
    const parsed = createSessionResponseSchema.safeParse(await response.json());

    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});

/**
 * **ノートを持っていない生徒の経路。**
 *
 * ノートを必須にしていた頃、この生徒には紙面を `photo`(ノート枠)に入れる以外の
 * 道が無く、結果として**他者の著作物がR2に保存されていた**。
 * 破棄の約束を守る唯一の道が「紙面をノート枠に入れる動機を消す」ことだったので、
 * ノートの必須をやめた(§4-1 / §10-4)。
 */
describe("問題だけのセッション", () => {
  function problemOnlyForm(meta: Record<string, unknown> = {}): FormData {
    const form = new FormData();
    form.set(sessionPhotoParts.problem, problemPhotoFile());
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja", ...meta }));
    return form;
  }

  /** 会話まで進めて、先輩に届く文脈を読む。 */
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

  // 破棄の約束そのもの。ノートが無いのだから、R2には**何も**増えない。
  it("紙面はR2に保存されない(バケツが空のまま)", async () => {
    // モジュール共有の bindings は他のテストが保存した写真を持っている
    // (session_id も ses_1 から振り直される)ので、ここだけ空のバケツで見る。
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
   * 「ノートを撮ったが白紙」と「ノートを撮っていない」は別物。
   * 混ぜると先輩は、まだ手をつけていない生徒から「手が止まった場所」を探しはじめる。
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

    // 文言の正本は `@ai-sensei/prompts` の formatVisibleWork(プロンプトが名指ししている)。
    // API側で組み立て直していないことを、正本と突き合わせて固定する。
    expect(metadata.visible_work).toBe(formatVisibleWork(null, "en"));
    expect(metadata.visible_work).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  // 単元を絞り込んだだけで「ノートがある」ことにならない(写真は解析し直さない)。
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
   * `problem_text` のプレースホルダと同じ手当て。プロンプト側には
   * 「ここが『(ノートの写真なし)』のときは手がかりが無い」という分岐があるので、
   * **1文字ずれるとその分岐が発火せず、先輩がノートを持っていない生徒に
   * 「ノート見せて」と言い出す。**
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

  // ここを緩めると「写真ゼロで始まるセッション」ができ、解析器が想像で単元を答える。
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
    // 読めない写真で解析の枠を失わせない(従来の約束)
    expect((await post(createSessionForm())).status).toBe(201);
  });

  /**
   * 復習は写真を使わず、文脈は前回の穴。ここに「ノートの写真なし」と書くと
   * **存在しない欠落**を報告することになる。
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

// レビュー指摘: 上限の判定と行の作成が離れていると、同時投稿で二重に通る
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

    // 撮り直せば、その日のうちにまだ始められる
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
    // 解析中にはもう行がある = 同時に来た解析も同じ枠を数える
    expect(sessionsDuringAnalysis).toBe(1);
  });
});

/**
 * 授業枠の原子性。**枠を押さえるのは会話の開始**になったので、
 * 同時実行の穴もそちらへ移っている。
 *
 * 解析まで済ませたセッションを人数分そろえてから、いっせいに始める。
 * 「数えてから書く」実装に戻すと、全員が同じ「まだ空いている」を見て通る。
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

  /** `/start` が `ensureUser` を通ったところで全員をそろえる関門。 */
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
 * 不具合報告: 写真 → 分野選択 → 会話開始 で「今日のセッションは終わり」と出た。
 * 単元を確認しただけでセッションを作り直していたため、無料枠を2回消費していた。
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
    // 同じセッションのまま。行が増えていなければ、解析も枠も二重にならない
    expect(body.session_id).toBe(session.session_id);
    expect(services.repository.sessions.size).toBe(1);
  });

  // 単元を確かめただけの人は、まだ1回も話していない。
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
    // 写真をもう一度解析しなくても、会話の文脈は残っている
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
 * 海外向けの課程で始めるセッション。
 *
 * 見ているのは「英語で返るか」ではなく、**会話に渡す文脈が最後まで
 * 英語の課程で揃っているか**。ここが混ざると、後輩が英語で話しながら
 * 日本語の単元名でガードレールを引くことになる。
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
