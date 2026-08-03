import type { D1Database, KVNamespace, R2Bucket } from "./cloudflare.ts";
import type { NotificationScheduler } from "./lib/notifications.ts";
import type { PhotoAnalyzer } from "./lib/photo-analysis.ts";
import type { Repository } from "./repository/types.ts";

/** wrangler.toml のバインディングと secret。 */
export type Bindings = {
  DB: D1Database;
  PHOTOS: R2Bucket;
  METER: KVNamespace;

  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;

  LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  LLM_MODEL_VISION?: string;

  ONESIGNAL_APP_ID?: string;
  ONESIGNAL_REST_API_KEY?: string;

  REVENUECAT_WEBHOOK_AUTH: string;
  REVENUECAT_ENTITLEMENT_ID?: string;

  INTERNAL_API_TOKEN: string;

  FREE_SESSIONS_PER_DAY?: string;
  FREE_SESSION_MAX_SECONDS?: string;
  PREMIUM_SESSION_MAX_SECONDS?: string;
};

/**
 * リクエストごとに差し替えられる依存。
 * テストではここに in-memory 実装を入れ、ネットワークもD1も使わずに
 * ルートの振る舞いを確かめる。
 */
export type Services = {
  repository: Repository;
  analyzer: PhotoAnalyzer;
  scheduler: NotificationScheduler;
  /** ID生成と現在時刻。テストで固定するために注入する。 */
  now: () => Date;
  newId: (prefix: string) => string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    services: Services;
    deviceId: string;
  };
};

export type Limits = {
  freeSessionsPerDay: number;
  freeSessionMaxSeconds: number;
  premiumSessionMaxSeconds: number;
};

export function readLimits(env: Bindings): Limits {
  return {
    freeSessionsPerDay: toInt(env.FREE_SESSIONS_PER_DAY, 1),
    freeSessionMaxSeconds: toInt(env.FREE_SESSION_MAX_SECONDS, 300),
    premiumSessionMaxSeconds: toInt(env.PREMIUM_SESSION_MAX_SECONDS, 900),
  };
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
