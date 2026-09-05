import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../env.ts";
import type { UserRecord } from "../repository/types.ts";

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
    /**
     * TRANSFER **だけ** app_user_id を持たない(移行元と移行先の2つがあるため)。
     * required にしていたころは、TRANSFER が zod で弾かれて400を返し、
     * RevenueCat が諦めるまで再送していた。
     */
    app_user_id: z.string().optional(),
    /** ミリ秒エポック。解約後も期限までは有効。 */
    expiration_at_ms: z.number().nullable().optional(),
    /**
     * 猶予期間(ストア側の Grace period)の終わり。BILLING_ISSUE に付く。
     * 支払いの再試行中も、ここまでは使わせる。
     */
    grace_period_expiration_at_ms: z.number().nullable().optional(),
    entitlement_ids: z.array(z.string()).nullable().optional(),
    /** TRANSFER のみ。移行元/移行先の app_user_id(複数あり得る)。 */
    transferred_from: z.array(z.string()).nullable().optional(),
    transferred_to: z.array(z.string()).nullable().optional(),
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
 *
 * BILLING_ISSUE も**ここに入れない**。あれは「支払いの再試行が始まった」で、
 * 失効ではない(下の handleBillingIssue)。
 *
 * TRANSFER も**ここに入れない**。剥奪ではなく付け替えなので、
 * 移行元から外して移行先に付ける(下の handleTransfer)。
 */
const revokingTypes = new Set(["EXPIRATION", "REFUND"]);

/**
 * BILLING_ISSUE の適用。**剥奪しない。**
 *
 * このイベントは「カードが通らなかったので再試行を始めた」の通知で、
 * ストア側の猶予期間(Play: Grace period / Apple: Billing Retry)のあいだ
 * RevenueCat の entitlement は**有効なまま**。
 *
 * ここで剥奪していたころは、猶予期間のあいだだけ
 *   アプリ(SDKのCustomerInfo) = Premium / サーバ(users.is_premium) = 無料
 * になった。画面の出し分けはサーバ側が正(docs/revenuecat.md §9)なので、
 * **カードを更新すれば直るはずの数日間、授業も復習も止まる**。
 * entitlement は変わっていないので premium_sync も読み直さない。
 *
 * やることは期限を猶予期間の終わりまで延ばすことだけ。
 * 猶予が明けても払われなければ EXPIRATION が来て、そこで剥奪される。
 */
async function handleBillingIssue(input: {
  repository: Services["repository"];
  deviceId: string;
  /** 猶予期間の終わり。無ければ従来の期限。どちらも無ければ null。 */
  until: string | null;
}): Promise<void> {
  const { repository, deviceId, until } = input;

  // 期限の材料が無いときは**触らない**。ここで expiresAt: null を書くと
  // 「無期限」の意味になり(handleTransfer 参照)、支払いに失敗しただけの人が
  // 永久Premiumになる。直前の RENEWAL が入れた期限をそのまま残せば、
  // 猶予がどうであれ EXPIRATION で正しく終わる。
  if (until === null) return;

  await repository.setPremium({
    deviceId,
    isPremium: true,
    expiresAt: until,
    rcAppUserId: deviceId,
  });
}

/**
 * TRANSFER の適用。
 *
 * このイベントは `expiration_at_ms` も `entitlement_ids` も持たない
 * (個別の商品ではなく「そのIDが持つものすべて」の付け替えなので)。
 * よって**期限は移行元のレコードから引き継ぐ**。
 *
 * 移行元にPremiumの記録が無ければ、こちらには期限を決める材料が無い。
 * 期限なし(=無期限)で付けてしまうと復元だけで永久Premiumが作れるので、
 * その場合は付けない。次の RENEWAL / EXPIRATION が新しいIDで飛んできて
 * そこで正しい期限に揃う。
 */
async function handleTransfer(input: {
  repository: Services["repository"];
  at: Date;
  from: string[];
  to: string[];
}): Promise<void> {
  const { repository, at, from, to } = input;

  // 先に読む。剥奪してから読むと、引き継ぐはずの期限が消える。
  const sources = await Promise.all(from.map((deviceId) => repository.getUser(deviceId)));
  const premiumSources = sources.filter((user): user is UserRecord => user?.is_premium === true);

  // premium_expires_at が null は「無期限」。混ざっていればそれが最長。
  const unbounded = premiumSources.some((user) => user.premium_expires_at === null);
  const expiresAt = unbounded
    ? null
    : premiumSources.reduce<string | null>((latest, user) => {
        const candidate = user.premium_expires_at;
        // ISO8601(UTC・同じ桁数)なので辞書順の比較で時刻順になる。
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
    // 設定を入れ替えたあとの拒否がここに出る。**課金だけ静かに壊れる**のを防ぐ。
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

  // 機種変更・アンインストール後の「購入を復元する」。
  //
  // 匿名デバイスIDは端末ごとに作り直されるので、復元すると RevenueCat が
  // 購入を古いIDから新しいIDへ**付け替えて** TRANSFER を送ってくる。
  // ここを処理しないと、アプリは「復元しました」と言うのに
  // サーバ側は無料のまま = 復習も履歴も開かない、という食い違いになる。
  if (event.type === "TRANSFER") {
    await handleTransfer({
      repository,
      at,
      from: event.transferred_from ?? [],
      to: event.transferred_to ?? [],
    });
    return c.json({ ok: true });
  }

  // TRANSFER 以外は app_user_id を必ず持つ。
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
    // 解約予約。期限までは Premium のままにする。
    await repository.setPremium({
      deviceId,
      isPremium: true,
      expiresAt,
      rcAppUserId: deviceId,
    });
  }

  return c.json({ ok: true });
});
