import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { testBindings, testDeviceId, testServices, type TestServices } from "../test-support.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

function postWebhook(event: Record<string, unknown>, auth = bindings.REVENUECAT_WEBHOOK_AUTH) {
  return app.request(
    "/v1/webhooks/revenuecat",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ event }),
    },
    bindings,
  );
}

describe("POST /v1/webhooks/revenuecat", () => {
  it("購入でPremiumになる", async () => {
    const response = await postWebhook({
      type: "INITIAL_PURCHASE",
      app_user_id: testDeviceId,
      expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
    });
    expect(response.status).toBe(200);

    const user = await services.repository.getUser(testDeviceId);
    expect(user?.is_premium).toBe(true);
    expect(user?.premium_expires_at).toBe("2026-09-03T00:00:00.000Z");
  });

  it("トライアル開始でもPremiumになる(7日間無料)", async () => {
    await postWebhook({
      type: "TRIAL_STARTED",
      app_user_id: testDeviceId,
      expiration_at_ms: Date.parse("2026-08-10T00:00:00.000Z"),
    });
    expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(true);
  });

  // 払ったぶんは最後まで使える、が誠実さ(HAMM)の最低線
  it("解約予約(CANCELLATION)では、期限までPremiumのままにする", async () => {
    await postWebhook({ type: "INITIAL_PURCHASE", app_user_id: testDeviceId, expiration_at_ms: null });
    await postWebhook({
      type: "CANCELLATION",
      app_user_id: testDeviceId,
      expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
    });

    const user = await services.repository.getUser(testDeviceId);
    expect(user?.is_premium).toBe(true);
    expect(user?.premium_expires_at).toBe("2026-09-03T00:00:00.000Z");
  });

  it("期限切れでPremiumを外す", async () => {
    await postWebhook({ type: "INITIAL_PURCHASE", app_user_id: testDeviceId, expiration_at_ms: null });
    await postWebhook({ type: "EXPIRATION", app_user_id: testDeviceId });

    expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(false);
  });

  it("返金でも即座にPremiumを外す", async () => {
    await postWebhook({ type: "INITIAL_PURCHASE", app_user_id: testDeviceId, expiration_at_ms: null });
    await postWebhook({ type: "REFUND", app_user_id: testDeviceId });

    expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(false);
  });

  it("認証が合わなければ401", async () => {
    const response = await postWebhook({ type: "INITIAL_PURCHASE", app_user_id: testDeviceId }, "wrong");
    expect(response.status).toBe(401);
    expect(await services.repository.getUser(testDeviceId)).toBeNull();
  });

  it("知らないイベント種別は素通しする(200を返して再送を止める)", async () => {
    const response = await postWebhook({ type: "TEST", app_user_id: testDeviceId });
    expect(response.status).toBe(200);
    expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(false);
  });

  it("想定外のペイロードは400", async () => {
    const response = await app.request(
      "/v1/webhooks/revenuecat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: bindings.REVENUECAT_WEBHOOK_AUTH,
        },
        body: JSON.stringify({ unexpected: true }),
      },
      bindings,
    );
    expect(response.status).toBe(400);
  });
});
