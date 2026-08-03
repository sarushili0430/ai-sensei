import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env.ts";

export const webhooksRoute = new Hono<AppEnv>();

/**
 * RevenueCatのwebhook。entitlementをD1に同期する。
 *
 * app_user_id は匿名デバイスID(RevenueCatのlogIn に渡す値)。
 * 検証は Authorization ヘッダの共有シークレットで行う(RevenueCat側で設定)。
 */
const revenueCatEventSchema = z.object({
  event: z.object({
    type: z.string(),
    app_user_id: z.string(),
    /** ミリ秒エポック。解約後も期限までは有効。 */
    expiration_at_ms: z.number().nullable().optional(),
    entitlement_ids: z.array(z.string()).nullable().optional(),
  }),
});

/** entitlementを与えるイベント。 */
const grantingTypes = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "SUBSCRIPTION_EXTENDED",
  "PRODUCT_CHANGE",
  "TRIAL_STARTED",
  "TRIAL_CONVERTED",
]);

/**
 * 即時に剥奪するイベント。
 * CANCELLATION(解約予約)は期限まで使えるので**ここに入れない**。
 * 払ったぶんは最後まで使える、が誠実さ(HAMM)の最低線。
 */
const revokingTypes = new Set(["EXPIRATION", "BILLING_ISSUE", "REFUND", "TRANSFER"]);

webhooksRoute.post("/revenuecat", async (c) => {
  const { repository, now } = c.get("services");

  const authorization = c.req.header("authorization");
  if (!c.env.REVENUECAT_WEBHOOK_AUTH || authorization !== c.env.REVENUECAT_WEBHOOK_AUTH) {
    return c.json({ error: { code: "unauthorized", message: "invalid webhook auth" } }, 401);
  }

  const parsed = revenueCatEventSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: { code: "internal_error", message: "unexpected payload" } }, 400);
  }

  const event = parsed.data.event;
  const deviceId = event.app_user_id;
  const at = now();
  await repository.ensureUser(deviceId, at);

  const expiresAt =
    event.expiration_at_ms != null ? new Date(event.expiration_at_ms).toISOString() : null;

  if (grantingTypes.has(event.type)) {
    await repository.setPremium({
      deviceId,
      isPremium: true,
      expiresAt,
      rcAppUserId: event.app_user_id,
    });
  } else if (revokingTypes.has(event.type)) {
    await repository.setPremium({
      deviceId,
      isPremium: false,
      expiresAt: null,
      rcAppUserId: event.app_user_id,
    });
  } else if (event.type === "CANCELLATION") {
    // 解約予約。期限までは Premium のままにする。
    await repository.setPremium({
      deviceId,
      isPremium: true,
      expiresAt,
      rcAppUserId: event.app_user_id,
    });
  }

  return c.json({ ok: true });
});
