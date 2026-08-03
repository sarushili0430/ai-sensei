import type { ProgressResponse, ReviewQueueResponse } from "@ai-sensei/contract";
import { progressResponseSchema, reviewQueueResponseSchema } from "@ai-sensei/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { testBindings, testDeviceId, testServices, type TestServices } from "../test-support.ts";
import type { HoleRecord, KarteRecord } from "../repository/types.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

function get(path: string) {
  return app.request(path, { headers: { "x-device-id": testDeviceId } }, bindings);
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
    expect(body.limits.remaining_sessions_today).toBe(1);
  });

  it("Premiumは残セッション数がnull(無制限)", async () => {
    await makePremium();
    const body = (await (await get("/v1/me/progress")).json()) as ProgressResponse;
    expect(body.is_premium).toBe(true);
    expect(body.limits.remaining_sessions_today).toBeNull();
    expect(body.limits.max_seconds).toBe(900);
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
    expect(body).toEqual({ items: [], requires_premium: true });
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

  it("埋まった穴は出さない", async () => {
    await makePremium();
    await seedHole({ status: "filled", filled_at: "2026-08-01T11:00:00.000Z" });

    const body = (await (await get("/v1/me/reviews")).json()) as ReviewQueueResponse;
    expect(body.items).toEqual([]);
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
