import type {
  ParentReportResponse,
  ProgressResponse,
  ReviewAnswerResponse,
  ReviewQueueResponse,
} from "@ai-sensei/contract";
import {
  parentReportQuoteMaxCount,
  parentReportResponseSchema,
  progressResponseSchema,
  reviewAnswerResponseSchema,
  reviewQueueResponseSchema,
} from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { HoleRecord, KarteRecord, SessionRecord } from "../repository/types.ts";
import { type TestServices, testBindings, testDeviceId, testServices } from "../test-support.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

function get(path: string) {
  return app.request(path, { headers: { "x-device-id": testDeviceId } }, bindings);
}

function answerReview(holeId: string, body: unknown, deviceId = testDeviceId) {
  return app.request(
    `/v1/me/reviews/${holeId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function sessionRow(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    device_id: testDeviceId,
    kind: "new",
    status: "open",
    created_at: "2026-08-03T13:00:00.000Z",
    completed_at: null,
    local_date: "2026-08-03",
    photo_key: null,
    topic_ids: [],
    hole_id: null,
    duration_seconds: null,
    context: null,
    started_at: null,
    ...overrides,
  };
}

/** 会話まで進んだセッション。**数えられるのはこれだけ**(`started_at` が入っている)。 */
async function startedSession(id: string, overrides: Partial<SessionRecord> = {}): Promise<void> {
  await services.repository.createSession({
    session: sessionRow(id, { started_at: "2026-08-03T13:00:00.000Z", ...overrides }),
    maxAnalysesPerDay: 99,
  });
}

async function seedHole(overrides: Partial<HoleRecord> = {}): Promise<HoleRecord> {
  const karte: KarteRecord = {
    id: "kar_seed",
    session_id: "ses_seed",
    device_id: testDeviceId,
    created_at: "2026-07-31T11:00:00.000Z",
    topic_ids: ["M1-NIJI-GURAFU"],
    said_well: [],
    term_notes: [],
    followup_question: null,
  };
  const hole: HoleRecord = {
    id: "hol_seed",
    device_id: testDeviceId,
    karte_id: karte.id,
    topic_id: "M1-NIJI-GURAFU",
    desc: "平方完成を「なぜ」するのか、で説明が止まった",
    severity: "high",
    evidence: null,
    quiz: null,
    status: "open",
    created_at: "2026-07-31T11:00:00.000Z",
    filled_at: null,
    ...overrides,
  };
  await services.repository.insertKarte(karte, [hole]);
  return hole;
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

describe("GET /v1/me/progress", () => {
  it("初回でも0で返す(履歴がなくてもエラーにしない)", async () => {
    const response = await get("/v1/me/progress");
    expect(response.status).toBe(200);

    const body = (await response.json()) as ProgressResponse;
    expect(progressResponseSchema.safeParse(body).success).toBe(true);
    expect(body.progress).toEqual({
      streak_days: 0,
      filled_holes: 0,
      open_holes: 0,
      last_session_date: null,
    });
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  it("無料ユーザーが今日の枠を使ったあとは授業不可を返す", async () => {
    await startedSession("ses_today", { status: "open" });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.lesson_allowed_today).toBe(false);
  });

  /**
   * 写真を読んだだけのセッションは行としては在るが、先輩とは1度も話していない。
   * ここを行数で数えていた頃は、撮って単元を確かめただけでホームの導線が閉じた。
   */
  it("写真を読んだだけで会話していないセッションは数えない", async () => {
    await services.repository.createSession({
      session: sessionRow("ses_analyzed", { started_at: null }),
      maxAnalysesPerDay: 5,
    });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  it("Premiumはフェアユース枠が残っていれば授業可で、無料と同じ20分を返す", async () => {
    await makePremium();
    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.is_premium).toBe(true);
    expect(body.limits.lesson_allowed_today).toBe(true);
    expect(body.limits.max_seconds).toBe(1200);
  });

  it("Premiumも3回を使ったあとは今日の授業不可だけを返す", async () => {
    await makePremium();
    for (let count = 0; count < 3; count += 1) {
      await startedSession(`ses_premium_${count}`, {
        status: "completed",
        completed_at: "2026-08-03T13:20:00.000Z",
        duration_seconds: 1200,
      });
    }

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.is_premium).toBe(true);
    expect(body.limits).toEqual({ max_seconds: 1200, lesson_allowed_today: false });
  });

  it("デバイスIDがなければ401", async () => {
    expect((await app.request("/v1/me/progress", {}, bindings)).status).toBe(401);
  });
});

describe("GET /v1/me/reviews", () => {
  it("無料ユーザーにも復習キューを返し、授業可否は混ぜない", async () => {
    await seedHole();
    const response = await get("/v1/me/reviews");
    expect(response.status).toBe(200);

    const body = (await response.json()) as ReviewQueueResponse;
    expect(reviewQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body).not.toHaveProperty("lesson_requires_premium");
    expect(body).not.toHaveProperty("lesson_allowed_today");
  });

  it("穴と先輩の一言を返す", async () => {
    await seedHole();

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.days_since).toBe(3);
    expect(body.items[0]?.prompt).toBe(
      "3日前の「平方完成を「なぜ」するのか」、いまなら説明できますか?",
    );
  });

  it("出題が無い旧データではdescをquizとして返す", async () => {
    const hole = await seedHole({ quiz: null });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items[0]?.quiz).toBe(hole.desc);
  });

  it("保存済みの出題があればquizをそのまま返す", async () => {
    await seedHole({ quiz: "平方完成をする理由を説明できる?" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items[0]?.quiz).toBe("平方完成をする理由を説明できる?");
  });

  it("埋まった穴は「埋めにいく穴」には出さず、「埋めた穴」に回す", async () => {
    await makePremium();
    await seedHole({ status: "filled", filled_at: "2026-08-01T11:00:00.000Z" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(reviewQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body.items).toEqual([]);
    expect(body.filled).toHaveLength(1);
    expect(body.filled[0]?.hole.id).toBe("hol_seed");
    expect(body.filled[0]?.days_since_filled).toBe(2);
  });

  it("埋めた穴は、埋めたばかりのものを上に並べる", async () => {
    await makePremium();
    await seedHole({ status: "filled", filled_at: "2026-07-31T11:00:00.000Z" });
    await services.repository.insertKarte(
      {
        id: "kar_3",
        session_id: "ses_3",
        device_id: testDeviceId,
        created_at: "2026-08-02T11:00:00.000Z",
        topic_ids: ["M1-NIJI-HANBETSU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_3",
          device_id: testDeviceId,
          karte_id: "kar_3",
          topic_id: "M1-NIJI-HANBETSU",
          desc: "判別式の意味で説明が止まった",
          severity: "medium",
          evidence: null,
          quiz: null,
          status: "filled",
          created_at: "2026-08-02T11:00:00.000Z",
          filled_at: "2026-08-02T11:30:00.000Z",
        },
      ],
    );

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.filled.map((it) => it.hole.id)).toEqual(["hol_3", "hol_seed"]);
  });

  it("無料ユーザーにも埋めた穴を返す", async () => {
    await seedHole({ status: "filled", filled_at: "2026-08-01T11:00:00.000Z" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.filled).toHaveLength(1);
  });

  it("古い穴から順に並べる", async () => {
    await makePremium();
    await seedHole();
    await services.repository.insertKarte(
      {
        id: "kar_2",
        session_id: "ses_2",
        device_id: testDeviceId,
        created_at: "2026-08-02T11:00:00.000Z",
        topic_ids: ["M1-NIJI-HANBETSU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_2",
          device_id: testDeviceId,
          karte_id: "kar_2",
          topic_id: "M1-NIJI-HANBETSU",
          desc: "判別式の意味で説明が止まった",
          severity: "medium",
          evidence: null,
          quiz: null,
          status: "open",
          created_at: "2026-08-02T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items.map((item) => item.hole.id)).toEqual(["hol_seed", "hol_2"]);
  });
});

describe("POST /v1/me/reviews/{holeId}", () => {
  async function seedSchedules(holeId: string): Promise<void> {
    await services.repository.insertReviewSchedules([
      {
        id: "rev_seed_1",
        hole_id: holeId,
        step: 1,
        scheduled_at: "2026-08-04T11:00:00.000Z",
        external_id: "os_seed_1",
      },
      {
        id: "rev_seed_2",
        hole_id: holeId,
        step: 2,
        scheduled_at: "2026-08-06T11:00:00.000Z",
        external_id: "os_seed_2",
      },
      {
        id: "rev_seed_3",
        hole_id: holeId,
        step: 3,
        scheduled_at: "2026-08-10T11:00:00.000Z",
        external_id: "os_seed_3",
      },
    ]);
  }

  it('"said_it" で穴が埋まり、進捗をその場で返す', async () => {
    const hole = await seedHole();
    const response = await answerReview(hole.id, { outcome: "said_it" });
    expect(response.status).toBe(200);

    const body = (await response.json()) as ReviewAnswerResponse;
    expect(reviewAnswerResponseSchema.safeParse(body).success).toBe(true);
    expect(body.hole.status).toBe("filled");
    expect(body.hole.filled_at).toBe("2026-08-03T13:24:07.000Z");
    expect(body.progress.filled_holes).toBe(1);
    expect(body.progress.open_holes).toBe(0);
  });

  it('"said_it" で残りの復習通知を取り消す', async () => {
    const hole = await seedHole();
    await seedSchedules(hole.id);

    await answerReview(hole.id, { outcome: "said_it" });

    expect(services.repository.schedules).toEqual([]);
    expect(services.scheduler.cancelled).toEqual(["os_seed_1", "os_seed_2", "os_seed_3"]);
  });

  it('"not_yet" では穴も通知もそのまま残す', async () => {
    const hole = await seedHole();
    await seedSchedules(hole.id);

    const response = await answerReview(hole.id, { outcome: "not_yet" });
    const body = (await response.json()) as ReviewAnswerResponse;

    expect(body.hole.status).toBe("open");
    expect(body.progress.filled_holes).toBe(0);
    expect(body.progress.open_holes).toBe(1);
    expect(services.repository.schedules).toHaveLength(3);
    expect(services.scheduler.cancelled).toEqual([]);
  });

  it("他人の穴には触れず404を返す", async () => {
    const hole = await seedHole();
    const response = await answerReview(
      hole.id,
      { outcome: "said_it" },
      "11111111-2222-3333-4444-555555555555",
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "hole_not_found",
    );
    expect((await services.repository.getHole(hole.id))?.status).toBe("open");
  });

  it('"said_it" を2度送っても埋めた穴を二重に数えない', async () => {
    const hole = await seedHole();
    await seedSchedules(hole.id);

    await answerReview(hole.id, { outcome: "said_it" });
    const second = await answerReview(hole.id, { outcome: "said_it" });
    const body = (await second.json()) as ReviewAnswerResponse;

    expect(body.progress.filled_holes).toBe(1);
    expect(services.scheduler.cancelled).toEqual(["os_seed_1", "os_seed_2", "os_seed_3"]);
  });

  it("スキーマに合わない本文は400", async () => {
    const hole = await seedHole();
    expect((await answerReview(hole.id, { outcome: "almost" })).status).toBe(400);
  });
});

// 復習画面の一行も、穴と同じ課程の言語で出す(通知文と同じ文面)。
describe("復習キューの言語", () => {
  it("英語の課程の穴には英語の一行を返す", async () => {
    await makePremium();
    await seedHole({
      topic_id: "A1-QUAD-SOLVE",
      desc: "the explanation stopped at why the discriminant is used",
    });

    const response = await get("/v1/me/reviews");
    const body = (await response.json()) as ReviewQueueResponse;

    expect(reviewQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body.items[0]?.prompt).toBe(
      'That "why the discriminant is used" from 3 days ago — could you explain it to me now?',
    );
  });

  it("日本の課程の穴は日本語のまま", async () => {
    await makePremium();
    await seedHole();

    const response = await get("/v1/me/reviews");
    const body = (await response.json()) as ReviewQueueResponse;
    expect(body.items[0]?.prompt).toContain("いまなら説明できますか?");
  });
});

async function seedReportKarte(input: {
  id: string;
  localDate: string;
  createdAt: string;
  topicIds: string[];
  saidWell: string[];
  holes?: HoleRecord[];
}): Promise<void> {
  const sessionId = `ses_${input.id}`;
  const created = await services.repository.createSession({
    session: sessionRow(sessionId, {
      status: "completed",
      created_at: input.createdAt,
      completed_at: input.createdAt,
      local_date: input.localDate,
      topic_ids: input.topicIds,
      duration_seconds: 900,
      started_at: input.createdAt,
    }),
    // これは原価上限のテストではなく、月次集計の履歴を作る足場。
    maxAnalysesPerDay: 99,
  });
  if (!created) throw new Error("親レポート用セッションを作れませんでした");

  await services.repository.insertKarte(
    {
      id: input.id,
      session_id: sessionId,
      device_id: testDeviceId,
      created_at: input.createdAt,
      topic_ids: input.topicIds,
      said_well: input.saidWell,
      term_notes: [],
      followup_question: null,
    },
    input.holes ?? [],
  );
}

describe("GET /v1/me/parent-report", () => {
  it("無料ユーザーには本文を漏らさず、ロック状態を200で返す", async () => {
    const response = await get("/v1/me/parent-report");
    expect(response.status).toBe(200);

    const body = (await response.json()) as ParentReportResponse;
    expect(parentReportResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ requires_premium: true, report: null });
  });

  it("Premiumには今月の実績と本人の言葉だけを返す", async () => {
    await makePremium();

    await seedReportKarte({
      id: "kar_july",
      localDate: "2026-07-31",
      createdAt: "2026-07-31T11:00:00.000Z",
      topicIds: ["M1-NIJI-GURAFU"],
      saidWell: ["先月の説明は今月へ混ぜない"],
      holes: [
        {
          id: "hol_july",
          device_id: testDeviceId,
          karte_id: "kar_july",
          topic_id: "M1-NIJI-GURAFU",
          desc: "平方完成の理由で説明が止まった",
          severity: "medium",
          evidence: null,
          quiz: null,
          status: "filled",
          created_at: "2026-07-31T11:00:00.000Z",
          filled_at: "2026-07-31T12:00:00.000Z",
        },
      ],
    });
    await seedReportKarte({
      id: "kar_august_1",
      localDate: "2026-08-01",
      createdAt: "2026-08-01T11:00:00.000Z",
      topicIds: ["M1-NIJI-HANBETSU"],
      saidWell: [],
    });
    await seedReportKarte({
      id: "kar_august_2",
      localDate: "2026-08-02",
      createdAt: "2026-08-02T11:00:00.000Z",
      topicIds: ["M2-ZUKEI-ENCHOKU"],
      saidWell: ["同じ説明", "距離と半径を比べれば交点の個数がわかります", "古い4件目"],
      holes: [
        {
          id: "hol_august",
          device_id: testDeviceId,
          karte_id: "kar_august_2",
          topic_id: "M1-NIJI-HANBETSU",
          desc: "判別式の意味で説明が止まった",
          severity: "medium",
          evidence: null,
          // 小テストの出題は本人の引用ではないので、親レポートへ混ぜない。
          quiz: "判別式から実数解の個数を説明できる?",
          status: "filled",
          created_at: "2026-08-01T11:00:00.000Z",
          filled_at: "2026-08-02T12:00:00.000Z",
        },
      ],
    });
    await seedReportKarte({
      id: "kar_august_3",
      localDate: "2026-08-03",
      createdAt: "2026-08-03T11:00:00.000Z",
      topicIds: ["M1-NIJI-HANBETSU"],
      saidWell: ["判別式は実数解の個数を調べるものです", "同じ説明"],
    });

    const response = await get("/v1/me/parent-report");
    const body = (await response.json()) as ParentReportResponse;
    expect(parentReportResponseSchema.safeParse(body).success).toBe(true);
    expect(body.requires_premium).toBe(false);
    if (body.requires_premium) throw new Error("Premiumの親レポートがロックされています");

    expect(body.report.period).toEqual({ start_date: "2026-08-01", end_date: "2026-08-03" });
    expect(body.report.filled_holes).toBe(1);
    expect(body.report.streak_days).toBe(4);
    expect(body.report.explained_topics).toEqual([
      { topic_id: "M1-NIJI-HANBETSU", name: "二次方程式の判別式と実数解の個数" },
      { topic_id: "M2-ZUKEI-ENCHOKU", name: "円と直線の位置関係" },
    ]);
    expect(body.report.quotes).toEqual([
      "判別式は実数解の個数を調べるものです",
      "同じ説明",
      "距離と半径を比べれば交点の個数がわかります",
    ]);
    expect(body.report.quotes).toHaveLength(parentReportQuoteMaxCount);
    expect(body.report.quotes).not.toContain("先月の説明は今月へ混ぜない");
    expect(JSON.stringify(body.report)).not.toContain("判別式から実数解の個数を説明できる?");
    expect(Object.keys(body.report)).not.toContain("accuracy");
  });

  it("デバイスIDがなければ401", async () => {
    expect((await app.request("/v1/me/parent-report", {}, bindings)).status).toBe(401);
  });
});
