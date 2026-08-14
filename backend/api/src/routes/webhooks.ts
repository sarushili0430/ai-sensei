import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../env.ts";
import type { UserRecord } from "../repository/types.ts";

export const webhooksRoute = new Hono<AppEnv>();

/**
 * RevenueCat's webhook. Syncs entitlements into D1.
 *
 * app_user_id is the anonymous device id (the value passed to RevenueCat's
 * logIn). Verification uses the shared secret in the Authorization header (set
 * on the RevenueCat side).
 */
const revenueCatEventSchema = z.object({
  event: z.object({
    type: z.string(),
    /**
     * TRANSFER alone has no app_user_id (it has a source and a destination).
     * While this was required, TRANSFER was rejected by zod with a 400 and
     * RevenueCat kept resending until it gave up.
     */
    app_user_id: z.string().optional(),
    /** Epoch milliseconds. Still valid until expiry after cancellation. */
    expiration_at_ms: z.number().nullable().optional(),
    /**
     * End of the store-side grace period. Attached to BILLING_ISSUE.
     * Access continues until then while payment is being retried.
     */
    grace_period_expiration_at_ms: z.number().nullable().optional(),
    entitlement_ids: z.array(z.string()).nullable().optional(),
    /** TRANSFER only. The source/destination app_user_ids (there may be several). */
    transferred_from: z.array(z.string()).nullable().optional(),
    transferred_to: z.array(z.string()).nullable().optional(),
  }),
});

/** Events that grant an entitlement. */
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
 * Events that revoke immediately.
 * CANCELLATION (a scheduled cancellation) is not here - it stays usable until
 * expiry. "What was paid for stays usable to the end" is the floor of honesty (HAMM).
 *
 * BILLING_ISSUE is not here either. It means "payment retry has begun", not
 * expiry (see handleBillingIssue below).
 *
 * TRANSFER is not here either. It is a reassignment, not a revocation: remove
 * from the source and grant to the destination (see handleTransfer below).
 */
const revokingTypes = new Set(["EXPIRATION", "REFUND"]);

/**
 * Applying BILLING_ISSUE. It does not revoke.
 *
 * This event notifies that the card failed and a retry has begun. During the
 * store's grace period (Play: Grace period / Apple: Billing Retry), the
 * RevenueCat entitlement stays valid.
 *
 * While this used to revoke, the grace period looked like
 *   app (SDK CustomerInfo) = Premium / server (users.is_premium) = free
 * and the server is authoritative for what the screen shows
 * (docs/revenuecat.md §9), so lessons and reviews stopped for days that a card
 * update would have fixed. The entitlement did not change, so premium_sync does
 * not re-read it either.
 *
 * All this does is extend the expiry to the end of the grace period. If payment
 * still fails, EXPIRATION arrives and revokes there.
 */
async function handleBillingIssue(input: {
  repository: Services["repository"];
  deviceId: string;
  /** End of the grace period; otherwise the existing expiry; null if neither. */
  until: string | null;
}): Promise<void> {
  const { repository, deviceId, until } = input;

  // With nothing to build an expiry from, do not touch it. Writing expiresAt: null
  // here means "no expiry" (see handleTransfer), which would make someone who
  // merely failed a payment Premium forever. Leaving the expiry set by the last
  // RENEWAL means EXPIRATION ends it correctly however the grace period goes.
  if (until === null) return;

  await repository.setPremium({
    deviceId,
    isPremium: true,
    expiresAt: until,
    rcAppUserId: deviceId,
  });
}

/**
 * Applying TRANSFER.
 *
 * This event has neither `expiration_at_ms` nor `entitlement_ids` (it reassigns
 * "everything that id holds", not a specific product), so the expiry is
 * inherited from the source record.
 *
 * If the source has no Premium record, there is nothing to derive an expiry
 * from. Granting with no expiry (= forever) would let a restore alone create
 * permanent Premium, so nothing is granted. The next RENEWAL / EXPIRATION
 * arrives on the new id and settles the correct expiry there.
 */
async function handleTransfer(input: {
  repository: Services["repository"];
  at: Date;
  from: string[];
  to: string[];
}): Promise<void> {
  const { repository, at, from, to } = input;

  // Read first. Reading after revoking loses the expiry we mean to inherit.
  const sources = await Promise.all(from.map((deviceId) => repository.getUser(deviceId)));
  const premiumSources = sources.filter((user): user is UserRecord => user?.is_premium === true);

  // A null premium_expires_at means "no expiry". If one is present, it is the longest.
  const unbounded = premiumSources.some((user) => user.premium_expires_at === null);
  const expiresAt = unbounded
    ? null
    : premiumSources.reduce<string | null>((latest, user) => {
        const candidate = user.premium_expires_at;
        // ISO8601 (UTC, fixed width), so lexicographic comparison is chronological.
        return candidate !== null && (latest === null || candidate > latest) ? candidate : latest;
      }, null);

  for (const deviceId of from) {
    await repository.ensureUser(deviceId, at);
    await repository.setPremium({
      deviceId,
      isPremium: false,
      expiresAt: null,
      rcAppUserId: deviceId,
    });
  }

  if (premiumSources.length === 0) return;

  for (const deviceId of to) {
    await repository.ensureUser(deviceId, at);
    await repository.setPremium({
      deviceId,
      isPremium: true,
      expiresAt,
      rcAppUserId: deviceId,
    });
  }
}

webhooksRoute.post("/revenuecat", async (c) => {
  const { repository, now } = c.get("services");
  const log = c.get("log");

  const authorization = c.req.header("authorization");
  if (!c.env.REVENUECAT_WEBHOOK_AUTH || authorization !== c.env.REVENUECAT_WEBHOOK_AUTH) {
    // A rejection after swapping the config shows up here. Stops billing from breaking silently.
    log?.warn("webhook_unauthorized", { source: "revenuecat" });
    return c.json({ error: { code: "unauthorized", message: "invalid webhook auth" } }, 401);
  }

  const parsed = revenueCatEventSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    log?.error("webhook_invalid_payload", parsed.error, { source: "revenuecat" });
    return c.json({ error: { code: "internal_error", message: "unexpected payload" } }, 400);
  }

  const event = parsed.data.event;
  const at = now();

  // "Restore purchases" after a new device or a reinstall.
  //
  // Anonymous device ids are regenerated per device, so a restore makes
  // RevenueCat reassign the purchase from the old id to the new one and send
  // TRANSFER. Without handling it, the app says "restored" while the server stays
  // free - reviews and history never open.
  if (event.type === "TRANSFER") {
    await handleTransfer({
      repository,
      at,
      from: event.transferred_from ?? [],
      to: event.transferred_to ?? [],
    });
    return c.json({ ok: true });
  }

  // Everything other than TRANSFER always has an app_user_id.
  const deviceId = event.app_user_id;
  if (!deviceId) {
    return c.json({ error: { code: "internal_error", message: "missing app_user_id" } }, 400);
  }
  await repository.ensureUser(deviceId, at);

  const expiresAt =
    event.expiration_at_ms != null ? new Date(event.expiration_at_ms).toISOString() : null;
  const graceExpiresAt =
    event.grace_period_expiration_at_ms != null
      ? new Date(event.grace_period_expiration_at_ms).toISOString()
      : null;

  if (event.type === "BILLING_ISSUE") {
    await handleBillingIssue({
      repository,
      deviceId,
      until: graceExpiresAt ?? expiresAt,
    });
    return c.json({ ok: true });
  }

  if (grantingTypes.has(event.type)) {
    await repository.setPremium({
      deviceId,
      isPremium: true,
      expiresAt,
      rcAppUserId: deviceId,
    });
  } else if (revokingTypes.has(event.type)) {
    await repository.setPremium({
      deviceId,
      isPremium: false,
      expiresAt: null,
      rcAppUserId: deviceId,
    });
  } else if (event.type === "CANCELLATION") {
    // A scheduled cancellation. Stays Premium until expiry.
    await repository.setPremium({
      deviceId,
      isPremium: true,
      expiresAt,
      rcAppUserId: deviceId,
    });
  }

  return c.json({ ok: true });
});
