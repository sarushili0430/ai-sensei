import type { CreateSessionResponse } from "@ai-sensei/contract";
import { createSessionResponseSchema } from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { verifyJwt } from "../lib/livekit.ts";
import {
  JPEG_BYTES,
  RecordingAnalyzer,
  type TestServices,
  analysisFixture,
  createSessionForm,
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

  // 名前つきワーカーのときは、トークンでディスパッチしないと部屋に誰も来ない
  it("LIVEKIT_AGENT_NAMEがあれば、トークンで後輩を呼ぶ", async () => {
    const named = testBindings({ LIVEKIT_AGENT_NAME: "ai-sensei-kohai" });
    const response = await app.request(
      "/v1/sessions",
      { method: "POST", body: createSessionForm(), headers: { "x-device-id": testDeviceId } },
      named,
    );
    const body = (await response.json()) as CreateSessionResponse;

    const claims = await verifyJwt(body.livekit.token, named.LIVEKIT_API_SECRET);
    const roomConfig = claims?.["roomConfig"] as { agents: { agent_name: string }[] } | undefined;
    expect(roomConfig?.agents[0]?.agent_name).toBe("ai-sensei-kohai");
    // 文脈はジョブ側にも載せる(エージェントが参加者を待たずに読めるように)
    const dispatched = JSON.parse(
      String((roomConfig?.agents[0] as { metadata?: string } | undefined)?.metadata),
    ) as { allowed_topic_ids: string[] };
    expect(dispatched.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
  });

  it("LIVEKIT_AGENT_NAMEが空なら自動ディスパッチに任せる", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;
    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    expect(claims?.["roomConfig"]).toBeUndefined();
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
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "out_of_scope",
    );
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
        async analyze({ contentType }) {
          received = contentType;
          return analysisFixture;
        },
      },
    };

    const form = new FormData();
    form.set("photo", new File([JPEG_BYTES], "note", { type: "application/octet-stream" }));
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

  it("読み取れない写真は今日の無料枠を消費しない", async () => {
    const form = new FormData();
    form.set("photo", new File([new Uint8Array([0, 1, 2, 3])], "note", { type: "image/heic" }));
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));
    expect((await post(form)).status).toBe(422);

    // 押さえた枠が返っていれば、撮り直した1枚はちゃんと通る
    expect((await post(createSessionForm())).status).toBe(201);
  });
});

// レビュー指摘: 復習はPremium機能なのに、hole_idを直接渡せば無料でも通っていた
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
          evidence: null,
          status: "open",
          created_at: "2026-08-01T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );
    return "hol_seed";
  }

  async function makePremium(): Promise<void> {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: null,
    });
  }

  function reviewForm(holeId: string): FormData {
    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "ja", hole_id: holeId }));
    return form;
  }

  it("無料ユーザーは hole_id を直接渡しても始められない", async () => {
    const holeId = await seedHole();
    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "premium_required",
    );
  });

  it("Premiumは写真なしで復習セッションを始められる", async () => {
    await makePremium();
    const holeId = await seedHole();

    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(body.kind).toBe("review");
    // 写真がなくても、穴から単元を引く
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-GURAFU"]);
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

    const response = await post(form);
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      locale: string;
      photo_summary: string;
    };

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

describe("検出単元の確信度", () => {
  it("解析器が返した確信度をそのまま渡す", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;

    const primary = body.detected_topics.find((t) => t.topic_id === "M2-ZUKEI-ENCHOKU");
    expect(primary?.confidence).toBe(0.92);
  });
});

// レビュー指摘: 無料枠の判定と行の作成が離れていると、同時投稿で二重に通る
describe("無料枠の押さえ方", () => {
  it("解析に失敗したら、その日の1回を消費しない", async () => {
    services = testServices({
      analysis: {
        is_math_note: false,
        summary: "英語の単語帳",
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

  it("解析の前に行を作って枠を押さえる", async () => {
    let sessionsDuringAnalysis = -1;
    services.analyzer = {
      async analyze() {
        sessionsDuringAnalysis = services.repository.sessions.size;
        return analysisFixture;
      },
    };

    await post(createSessionForm());
    // 解析中にはもう行がある = 同時に来た2本目は無料枠に弾かれる
    expect(sessionsDuringAnalysis).toBe(1);
  });
});

/**
 * 不具合報告: 写真 → 分野選択 → 会話開始 で「今日のセッションは終わり」と出た。
 * 単元を確認しただけでセッションを作り直していたため、無料枠を2回消費していた。
 */
describe("PATCH /v1/sessions/{id}/topics", () => {
  async function startSession(): Promise<CreateSessionResponse> {
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  it("単元を絞っても、今日の無料枠を二重に消費しない", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      locale: "ja",
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    // 同じセッションのまま。行が増えていなければ枠も増えない
    expect(body.session_id).toBe(session.session_id);
    expect(services.repository.sessions.size).toBe(1);
    expect(body.limits.remaining_sessions_today).toBe(0);
  });

  it("外した単元は許可リストから消え、トークンも出し直す", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M1-NIJI-HANBETSU"],
    });
    const body = (await response.json()) as CreateSessionResponse;

    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-HANBETSU"]);
    expect(body.livekit.token).not.toBe(session.livekit.token);

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      allowed_topic_ids: string[];
      photo_summary: string;
    };
    expect(metadata.allowed_topic_ids).not.toContain("M2-ZUKEI-ENCHOKU");
    // 写真をもう一度解析しなくても、会話の文脈は残っている
    expect(metadata.photo_summary).toBe(analysisFixture.summary);
  });

  it("解析時の確信度をそのまま返す(チップの見た目が変わらない)", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics[0]?.confidence).toBe(0.92);
  });

  it("検出していない単元には差し替えられない", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M1-NIJI-GURAFU"],
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "photo_unreadable",
    );
  });

  it("他人のセッションは触れない", async () => {
    const session = await startSession();

    const response = await patchTopics(
      session.session_id,
      { topic_ids: ["M2-ZUKEI-ENCHOKU"] },
      { "x-device-id": "99999999-8888-7777-6666-555555555555" },
    );
    expect(response.status).toBe(404);
  });

  it("終わったセッションは触れない", async () => {
    const session = await startSession();
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

  it("Premiumは会話時間の上限が長いまま", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: "rc_1",
    });
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.limits.max_seconds).toBe(900);
    expect(body.limits.remaining_sessions_today).toBeNull();
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

    expect(analyzer.calls).toEqual([{ locale: "en" }]);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.detected_topics.map((topic) => topic.topic_id)).toContain("A2-COORD-CIRCLE");
    expect(body.detected_topics.map((topic) => topic.course)).toContain("Algebra 2");
  });

  it("エージェントに渡す文脈も英語で揃える", async () => {
    const response = await post(createSessionForm({ locale: "en" }));
    const body = (await response.json()) as CreateSessionResponse;

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      locale: string;
      allowed_topics: string;
      allowed_topic_ids: string[];
      question_seeds: string;
    };

    expect(metadata.locale).toBe("en");
    expect(metadata.allowed_topics).toContain("Algebra 2 / Coordinate Geometry");
    expect(metadata.allowed_topics).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    for (const id of metadata.allowed_topic_ids) {
      expect(localeOfTopicId(id), id).toBe("en");
    }
  });

  it("エラー文言も英語で返す", async () => {
    await post(createSessionForm({ locale: "en" }));
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

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as { locale: string };
    expect(metadata.locale).toBe("en");
  });
});
