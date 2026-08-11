import type { ProgressResponse, ReviewQueueResponse } from "@ai-sensei/contract";
import { progressResponseSchema, reviewQueueResponseSchema } from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
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

function post(path: string) {
  return app.request(path, { method: "POST", headers: { "x-device-id": testDeviceId } }, bindings);
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

describe("GET /v1/me/reviews", () => {
  it("無料ユーザーには空配列 + requires_premium(エラーにはしない)", async () => {
    await seedHole();
    const response = await get("/v1/me/reviews");
    expect(response.status).toBe(200);

    const body = (await response.json()) as ReviewQueueResponse;
    expect(reviewQueueResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ items: [], filled: [], requires_premium: true });
  });

  it("Premiumには穴と後輩の一言を返す", async () => {
    await makePremium();
    await seedHole();

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.requires_premium).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.days_since).toBe(3);
    expect(body.items[0]?.prompt).toBe(
      "3日前の「平方完成を「なぜ」するのか」、いまなら説明できますか?",
    );
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
          status: "filled",
          created_at: "2026-08-02T11:00:00.000Z",
          filled_at: "2026-08-02T11:30:00.000Z",
        },
      ],
    );

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.filled.map((it) => it.hole.id)).toEqual(["hol_3", "hol_seed"]);
  });

  it("無料ユーザーには埋めた穴も出さない(復習ごとPremium)", async () => {
    await seedHole({ status: "filled", filled_at: "2026-08-01T11:00:00.000Z" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.filled).toEqual([]);
    expect(body.requires_premium).toBe(true);
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

describe("POST /v1/me/holes/:holeId/filled", () => {
  it("自分の穴を埋め、残っている復習通知をD1と配信先の両方から取り消す", async () => {
    const hole = await seedHole();
    await services.repository.insertReviewSchedules([
      {
        id: "rev_1",
        hole_id: hole.id,
        step: 1,
        scheduled_at: "2026-08-04T13:24:07.000Z",
        external_id: "os_1",
      },
      {
        id: "rev_2",
        hole_id: hole.id,
        step: 2,
        scheduled_at: "2026-08-06T13:24:07.000Z",
        external_id: null,
      },
      {
        id: "rev_3",
        hole_id: hole.id,
        step: 3,
        scheduled_at: "2026-08-10T13:24:07.000Z",
        external_id: "os_3",
      },
    ]);

    const response = await post(`/v1/me/holes/${hole.id}/filled`);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await services.repository.getHole(hole.id)).toMatchObject({
      status: "filled",
      filled_at: "2026-08-03T13:24:07.000Z",
    });
    expect(services.repository.schedules).toEqual([]);
    expect(services.scheduler.cancelled).toEqual(["os_1", "os_3"]);
  });

  it("他人の穴IDは存在しないものと同じ404にして、穴も通知も変更しない", async () => {
    const hole = await seedHole({
      device_id: "99999999-8888-7777-6666-555555555555",
    });
    await services.repository.insertReviewSchedules([
      {
        id: "rev_other",
        hole_id: hole.id,
        step: 1,
        scheduled_at: "2026-08-04T13:24:07.000Z",
        external_id: "os_other",
      },
    ]);

    const response = await post(`/v1/me/holes/${hole.id}/filled`);

    expect(response.status).toBe(404);
    expect(await services.repository.getHole(hole.id)).toMatchObject({
      status: "open",
      filled_at: null,
    });
    expect(services.repository.schedules).toHaveLength(1);
    expect(services.scheduler.cancelled).toEqual([]);
  });

  it("二度押ししても最初のfilled_atを保ち、同じ通知を二度取り消さない", async () => {
    const hole = await seedHole();
    await services.repository.insertReviewSchedules([
      {
        id: "rev_once",
        hole_id: hole.id,
        step: 1,
        scheduled_at: "2026-08-04T13:24:07.000Z",
        external_id: "os_once",
      },
    ]);

    expect((await post(`/v1/me/holes/${hole.id}/filled`)).status).toBe(204);
    services.now = () => new Date("2026-08-05T13:24:07.000Z");
    expect((await post(`/v1/me/holes/${hole.id}/filled`)).status).toBe(204);

    expect(await services.repository.getHole(hole.id)).toMatchObject({
      status: "filled",
      filled_at: "2026-08-03T13:24:07.000Z",
    });
    expect(services.repository.schedules).toEqual([]);
    expect(services.scheduler.cancelled).toEqual(["os_once"]);
  });
});
