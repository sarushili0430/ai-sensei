import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { type TestServices, testBindings, testDeviceId, testServices } from "../test-support.ts";

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
    await postWebhook({
      type: "INITIAL_PURCHASE",
      app_user_id: testDeviceId,
      expiration_at_ms: null,
    });
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
    await postWebhook({
      type: "INITIAL_PURCHASE",
      app_user_id: testDeviceId,
      expiration_at_ms: null,
    });
    await postWebhook({ type: "EXPIRATION", app_user_id: testDeviceId });

    expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(false);
  });

  it("返金でも即座にPremiumを外す", async () => {
    await postWebhook({
      type: "INITIAL_PURCHASE",
      app_user_id: testDeviceId,
      expiration_at_ms: null,
    });
    await postWebhook({ type: "REFUND", app_user_id: testDeviceId });

    expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(false);
  });

  // 支払い失敗は失効ではない。ここで剥奪すると、猶予期間のあいだだけ
  // アプリはPremium・サーバは無料になり、カードを更新すれば直るはずの
  // 数日間、授業も復習も止まる(docs/revenuecat.md §9)。
  describe("BILLING_ISSUE(支払いの再試行が始まっただけ)", () => {
    it("Premiumを外さず、猶予期間の終わりまで延ばす", async () => {
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
      });
      const response = await postWebhook({
        type: "BILLING_ISSUE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
        grace_period_expiration_at_ms: Date.parse("2026-09-06T00:00:00.000Z"),
      });
      expect(response.status).toBe(200);

      const user = await services.repository.getUser(testDeviceId);
      expect(user?.is_premium).toBe(true);
      expect(user?.premium_expires_at).toBe("2026-09-06T00:00:00.000Z");
    });

    // 猶予期間を0日にしているストアでは grace_period_expiration_at_ms が来ない
    it("猶予期間が無ければ、そのイベントの期限をそのまま使う", async () => {
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
      });
      await postWebhook({
        type: "BILLING_ISSUE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
      });

      const user = await services.repository.getUser(testDeviceId);
      expect(user?.is_premium).toBe(true);
      expect(user?.premium_expires_at).toBe("2026-09-03T00:00:00.000Z");
    });

    // 期限なしで付け直すと「無期限」の意味になる(handleTransfer と同じ理由)。
    // 支払いに失敗しただけの人が永久Premiumになってはいけない。
    it("期限の材料が1つも無ければ、いまの期限を書き換えない", async () => {
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
      });
      await postWebhook({ type: "BILLING_ISSUE", app_user_id: testDeviceId });

      const user = await services.repository.getUser(testDeviceId);
      expect(user?.is_premium).toBe(true);
      expect(user?.premium_expires_at).toBe("2026-09-03T00:00:00.000Z");
    });

    it("猶予が明けても払われなければ、EXPIRATION で外れる", async () => {
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
      });
      await postWebhook({
        type: "BILLING_ISSUE",
        app_user_id: testDeviceId,
        grace_period_expiration_at_ms: Date.parse("2026-09-06T00:00:00.000Z"),
      });
      await postWebhook({ type: "EXPIRATION", app_user_id: testDeviceId });

      expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(false);
    });
  });

  // 機種変更・再インストール後の「購入を復元する」。
  // 匿名デバイスIDは作り直されるので、RevenueCat は購入を付け替えて
  // TRANSFER を送ってくる。ここを落とすと、アプリは「復元しました」と言うのに
  // サーバは無料のまま = 復習も履歴も開かない。
  describe("TRANSFER(復元によるIDの付け替え)", () => {
    const newDeviceId = "dev_after_reinstall";

    it("移行先にPremiumを付け、移行元から外す", async () => {
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
      });

      const response = await postWebhook({
        type: "TRANSFER",
        transferred_from: [testDeviceId],
        transferred_to: [newDeviceId],
      });
      expect(response.status).toBe(200);

      const moved = await services.repository.getUser(newDeviceId);
      expect(moved?.is_premium).toBe(true);
      // TRANSFER は expiration_at_ms を持たないので、期限は移行元から引き継ぐ
      expect(moved?.premium_expires_at).toBe("2026-09-03T00:00:00.000Z");

      expect((await services.repository.getUser(testDeviceId))?.is_premium).toBe(false);
    });

    // app_user_id が無いのがこのイベントの特徴。required にしていたころは
    // ここで400を返し、RevenueCat が諦めるまで再送していた。
    it("app_user_id が無くても400にしない", async () => {
      const response = await postWebhook({
        type: "TRANSFER",
        transferred_from: [testDeviceId],
        transferred_to: [newDeviceId],
      });
      expect(response.status).toBe(200);
    });

    // 復元だけで永久Premiumが作れてしまわないようにする。
    it("移行元にPremiumの記録が無ければ、移行先に付けない", async () => {
      await postWebhook({
        type: "TRANSFER",
        transferred_from: [testDeviceId],
        transferred_to: [newDeviceId],
      });

      // 付けないので行も作らない(その端末が初めてAPIを叩いたときに作られる)
      const moved = await services.repository.getUser(newDeviceId);
      expect(moved?.is_premium ?? false).toBe(false);
    });

    it("無期限のPremiumはそのまま無期限で引き継ぐ", async () => {
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: testDeviceId,
        expiration_at_ms: null,
      });
      await postWebhook({
        type: "TRANSFER",
        transferred_from: [testDeviceId],
        transferred_to: [newDeviceId],
      });

      const moved = await services.repository.getUser(newDeviceId);
      expect(moved?.is_premium).toBe(true);
      expect(moved?.premium_expires_at).toBeNull();
    });

    it("移行元が複数あればいちばん長い期限を引き継ぐ", async () => {
      const other = "dev_other";
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: testDeviceId,
        expiration_at_ms: Date.parse("2026-09-03T00:00:00.000Z"),
      });
      await postWebhook({
        type: "INITIAL_PURCHASE",
        app_user_id: other,
        expiration_at_ms: Date.parse("2026-12-03T00:00:00.000Z"),
      });

      await postWebhook({
        type: "TRANSFER",
        transferred_from: [testDeviceId, other],
        transferred_to: [newDeviceId],
      });

      expect((await services.repository.getUser(newDeviceId))?.premium_expires_at).toBe(
        "2026-12-03T00:00:00.000Z",
      );
    });
  });

  it("認証が合わなければ401", async () => {
    const response = await postWebhook(
      { type: "INITIAL_PURCHASE", app_user_id: testDeviceId },
      "wrong",
    );
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
