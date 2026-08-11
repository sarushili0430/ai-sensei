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
  studyRoomDailyMaxSeconds,
  studyRoomVisitMaxSeconds,
} from "@ai-sensei/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { HoleRecord, KarteRecord } from "../repository/types.ts";
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

const visitId = "00000000-0000-4000-8000-000000000001";

function postStudyRoom(
  body: unknown,
  idempotencyKey: string | null = visitId,
  requestBindings = bindings,
) {
  return app.request(
    "/v1/me/study-room",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": testDeviceId,
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
    requestBindings,
  );
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
    await services.repository.reserveSessionSlot({
      session: {
        id: "ses_today",
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
      },
      maxPerDay: 1,
    });

    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.limits.lesson_allowed_today).toBe(false);
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
      await services.repository.reserveSessionSlot({
        session: {
          id: `ses_premium_${count}`,
          device_id: testDeviceId,
          kind: "new",
          status: "completed",
          created_at: "2026-08-03T13:00:00.000Z",
          completed_at: "2026-08-03T13:20:00.000Z",
          local_date: "2026-08-03",
          photo_key: null,
          topic_ids: [],
          hole_id: null,
          duration_seconds: 1200,
          context: null,
        },
        maxPerDay: 3,
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

describe("POST /v1/me/study-room", () => {
  it("日次の内部指標へ積み、アプリには数字を返さない", async () => {
    const response = await postStudyRoom({ duration_seconds: 25 * 60, visited_on: "2026-08-03" });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect([...services.repository.studyRoomDays.values()]).toEqual([
      {
        device_id: testDeviceId,
        local_date: "2026-08-03",
        total_seconds: 25 * 60,
        last_visit_id: visitId,
        updated_at: "2026-08-03T13:24:07.000Z",
      },
    ]);
  });

  it.each([
    ["負数", -1],
    ["0秒", 0],
    ["端数", 1.5],
    ["上端超過", studyRoomVisitMaxSeconds + 1],
  ])("%sの滞在秒数を弾く", async (_case, durationSeconds) => {
    const response = await postStudyRoom({
      duration_seconds: durationSeconds,
      visited_on: "2026-08-03",
    });

    expect(response.status).toBe(400);
    expect(services.repository.studyRoomDays.size).toBe(0);
  });

  it.each(["2026-02-30", "2026/08/03", "2026-08-01", "2026-08-05"])(
    "存在しない日・形式違い・端末時計のずれを弾く: %s",
    async (visitedOn) => {
      const response = await postStudyRoom({ duration_seconds: 60, visited_on: visitedOn });

      expect(response.status).toBe(400);
      expect(services.repository.studyRoomDays.size).toBe(0);
    },
  );

  it.each(["2026-08-02", "2026-08-04"])(
    "UTCの前日・翌日は海外端末の正常なローカル日付として受け入れる: %s",
    async (visitedOn) => {
      expect((await postStudyRoom({ duration_seconds: 60, visited_on: visitedOn })).status).toBe(
        204,
      );
    },
  );

  it("本文に板書・単元などを混ぜた申告を弾く(strict)", async () => {
    const response = await postStudyRoom({
      duration_seconds: 60,
      visited_on: "2026-08-03",
      topic_id: "M1-NIJI-HANBETSU",
    });

    expect(response.status).toBe(400);
    expect(services.repository.studyRoomDays.size).toBe(0);
  });

  it("配送用UUIDが無い・壊れている申告を弾く", async () => {
    const body = { duration_seconds: 60, visited_on: "2026-08-03" };

    expect((await postStudyRoom(body, null)).status).toBe(400);
    expect((await postStudyRoom(body, "same-visit")).status).toBe(400);
    expect(services.repository.studyRoomDays.size).toBe(0);
  });

  it("同じ退室イベントが二重に届いても1回分しか足さない", async () => {
    expect((await postStudyRoom({ duration_seconds: 600, visited_on: "2026-08-03" })).status).toBe(
      204,
    );
    // 同じUUIDで本文が変わっても、再送として扱う。本文を鍵にすると同じ秒数の
    // 別訪問と区別できず、逆にUUIDを本文へ足すと「秒数と日付だけ」を破るため。
    expect((await postStudyRoom({ duration_seconds: 900, visited_on: "2026-08-03" })).status).toBe(
      204,
    );

    const daily = [...services.repository.studyRoomDays.values()][0];
    expect(daily).toMatchObject({ total_seconds: 600 });
  });

  it("別の退室イベントは同じ日の1行へ合算する", async () => {
    await postStudyRoom({ duration_seconds: 600, visited_on: "2026-08-03" });
    await postStudyRoom(
      { duration_seconds: 900, visited_on: "2026-08-03" },
      "00000000-0000-4000-8000-000000000002",
    );

    expect(services.repository.studyRoomDays.size).toBe(1);
    expect([...services.repository.studyRoomDays.values()][0]).toMatchObject({
      total_seconds: 1500,
    });
  });

  it("異なるUUIDを連投されても日次上限より増やさない", async () => {
    for (let index = 1; index <= 4; index += 1) {
      await postStudyRoom(
        { duration_seconds: studyRoomVisitMaxSeconds, visited_on: "2026-08-03" },
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
    }

    expect([...services.repository.studyRoomDays.values()][0]).toMatchObject({
      total_seconds: studyRoomDailyMaxSeconds,
    });
  });

  it("構造化ログは集計に要る数値だけを1行にし、識別子を載せない", async () => {
    const lines: string[] = [];
    const sink = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      const response = await postStudyRoom(
        { duration_seconds: 300, visited_on: "2026-08-03" },
        visitId,
        testBindings({ LOG_LEVEL: "info" }),
      );
      expect(response.status).toBe(204);

      const event = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line["event"] === "study_room_visit");
      expect(event).toMatchObject({
        visited_on: "2026-08-03",
        duration_seconds: 300,
        daily_total_seconds: 300,
        recorded: true,
      });
      expect(event).not.toHaveProperty("visit_id");
      expect(event).not.toHaveProperty("device");
    } finally {
      sink.mockRestore();
    }
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
  const reservation = await services.repository.reserveSessionSlot({
    session: {
      id: sessionId,
      device_id: testDeviceId,
      kind: "new",
      status: "completed",
      created_at: input.createdAt,
      completed_at: input.createdAt,
      local_date: input.localDate,
      photo_key: null,
      topic_ids: input.topicIds,
      hole_id: null,
      duration_seconds: 900,
      context: null,
    },
    // これは原価上限のテストではなく、月次集計の履歴を作る足場。
    maxPerDay: 99,
  });
  if (!reservation.reserved) throw new Error("親レポート用セッションを作れませんでした");

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
