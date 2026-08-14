import type { D1Database, KVNamespace, R2Bucket } from "./cloudflare.ts";
import type { NotificationScheduler } from "./lib/notifications.ts";
import type { RequestLogger } from "./lib/observability.ts";
import type { PhotoAnalyzer } from "./lib/photo-analysis.ts";
import type { Repository } from "./repository/types.ts";

/** wrangler.toml bindings and secrets. */
export type Bindings = {
  DB: D1Database;
  PHOTOS: R2Bucket;
  METER: KVNamespace;

  /** "local" | "develop" | "production". Returned by /health, so a wrong deploy target is noticeable. */
  ENVIRONMENT?: string;

  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  /**
   * The agent worker's name. Set only when it runs *with* a name.
   *
   * LiveKit Cloud agent hosting sets `LIVEKIT_AGENT_NAME` automatically. Named
   * workers are excluded from auto dispatch, so leaving this empty means nobody
   * joins the room (the app sits on "listening").
   */
  LIVEKIT_AGENT_NAME?: string;

  LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  LLM_MODEL_VISION?: string;

  ONESIGNAL_APP_ID?: string;
  ONESIGNAL_REST_API_KEY?: string;

  REVENUECAT_WEBHOOK_AUTH: string;
  REVENUECAT_ENTITLEMENT_ID?: string;

  INTERNAL_API_TOKEN: string;

  /** If set, errors go to Sentry. Otherwise structured logs only (local). */
  SENTRY_DSN?: string;

  /** Set to `"error"` to drop the per-request line and keep only failures. Defaults to info. */
  LOG_LEVEL?: string;

  FREE_SESSIONS_PER_DAY?: string;
  PREMIUM_SESSIONS_PER_DAY?: string;
  FREE_SESSION_MAX_SECONDS?: string;
  PREMIUM_SESSION_MAX_SECONDS?: string;

  /**
   * The closed beta's open-access deadline (ISO8601). While set, everyone is
   * Premium-equivalent.
   *
   * Only use this while distribution is limited to the closed testing list (Play
   * closed testing / TestFlight). Remove it once "everyone" no longer means
   * "testers".
   *
   * It carries a date so it ends by itself if forgotten. An open-ended flag is
   * only ever discovered on public launch, as "somehow nobody sees the paywall".
   */
  BETA_OPEN_ACCESS_UNTIL?: string;
  /** Daily lesson count during beta. High enough to feel unlimited, low enough to stop runaway use. */
  BETA_SESSIONS_PER_DAY?: string;
};

/**
 * Dependencies swappable per request.
 * Tests inject in-memory implementations here and check route behaviour without
 * touching the network or D1.
 */
export type Services = {
  repository: Repository;
  analyzer: PhotoAnalyzer;
  scheduler: NotificationScheduler;
  /** ID generation and the current time. Injected so tests can pin them. */
  now: () => Date;
  newId: (prefix: string) => string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    services: Services;
    deviceId: string;
    /** The per-request logger. Every line carries the same trace_id. */
    log: RequestLogger;
    traceId: string;
  };
};

export type Limits = {
  freeSessionsPerDay: number;
  premiumSessionsPerDay: number;
  freeSessionMaxSeconds: number;
  premiumSessionMaxSeconds: number;
  /** The closed beta's deadline. `null` means business as usual (= only payers are Premium). */
  betaOpenAccessUntil: Date | null;
  betaSessionsPerDay: number;
};

export function readLimits(env: Bindings): Limits {
  return {
    freeSessionsPerDay: toInt(env.FREE_SESSIONS_PER_DAY, 1),
    // A minimal fair-use cap that never hits ordinary 1-2 lessons a day and stops only abuse.
    premiumSessionsPerDay: toInt(env.PREMIUM_SESSIONS_PER_DAY, 3),
    // Even the free trial keeps full quality; the default is the top end that completes the designed 15-20 minutes.
    freeSessionMaxSeconds: toInt(env.FREE_SESSION_MAX_SECONDS, 1200),
    premiumSessionMaxSeconds: toInt(env.PREMIUM_SESSION_MAX_SECONDS, 1200),
    betaOpenAccessUntil: toDate(env.BETA_OPEN_ACCESS_UNTIL),
    // High enough never to hit ordinary use (1-2 a day), only stopping runaway cost.
    betaSessionsPerDay: toInt(env.BETA_SESSIONS_PER_DAY, 10),
  };
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Unreadable values fall to `null` = business as usual.
 *
 * A mistyped date falling toward "open access" would keep billing off with
 * nobody noticing. Falling the other way, a tester hits the free tier and tells us.
 */
function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
