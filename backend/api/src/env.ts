import type { D1Database, KVNamespace, R2Bucket } from "./cloudflare.ts";
import type { NotificationScheduler } from "./lib/notifications.ts";
import type { RequestLogger } from "./lib/observability.ts";
import type { PhotoAnalyzer } from "./lib/photo-analysis.ts";
import type { Repository } from "./repository/types.ts";

/** wrangler.toml のバインディングと secret。 */
export type Bindings = {
  DB: D1Database;
  PHOTOS: R2Bucket;
  METER: KVNamespace;

  /** "local" | "develop" | "production"。/health が返すので、デプロイ先の取り違えに気づける。 */
  ENVIRONMENT?: string;

  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  /**
   * 後輩(agent)ワーカーの名前。**名前つきで動かしているときだけ**設定する。
   *
   * LiveKit Cloud のエージェントホスティングは `LIVEKIT_AGENT_NAME` を自動で入れる。
   * 名前つきワーカーは自動ディスパッチの対象外なので、ここを空のままにすると
   * 部屋に誰も来ない(アプリは「聞いています」のまま止まる)。
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

  /** 設定されていればエラーをSentryへ送る。無ければ構造化ログだけ(ローカル)。 */
  SENTRY_DSN?: string;

  /** `"error"` にすると全リクエストの1行を落として失敗だけ残す。既定は info。 */
  LOG_LEVEL?: string;

  FREE_SESSIONS_PER_DAY?: string;
  PREMIUM_SESSIONS_PER_DAY?: string;
  FREE_SESSION_MAX_SECONDS?: string;
  PREMIUM_SESSION_MAX_SECONDS?: string;

  /**
   * クローズドβの開放期限(ISO8601)。**入っている間だけ、全員がPremium相当**になる。
   *
   * 配れるのが限定公開テストの名簿(Play の closed testing / TestFlight)に
   * 載っている人だけ、という状態でのみ使う設定。**「全員」= テスター**が
   * 成り立たなくなったら外すこと。
   *
   * 日付を持たせて、外し忘れても勝手に終わるようにしている。無期限のフラグは
   * 一般公開の日に「なぜか誰も課金画面を見ない」という形で発覚する。
   */
  BETA_OPEN_ACCESS_UNTIL?: string;
  /** β開放中の1日の授業本数。使い放題の体感を出しつつ、暴走だけ止める高さにする。 */
  BETA_SESSIONS_PER_DAY?: string;
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
    /** リクエスト単位のロガー。全行に同じ trace_id が入る。 */
    log: RequestLogger;
    traceId: string;
  };
};

export type Limits = {
  freeSessionsPerDay: number;
  premiumSessionsPerDay: number;
  freeSessionMaxSeconds: number;
  premiumSessionMaxSeconds: number;
  /** クローズドβの開放期限。`null` は通常営業(= 課金した人だけがPremium)。 */
  betaOpenAccessUntil: Date | null;
  betaSessionsPerDay: number;
};

export function readLimits(env: Bindings): Limits {
  return {
    freeSessionsPerDay: toInt(env.FREE_SESSIONS_PER_DAY, 1),
    // 通常利用の1日1〜2回には当てず、異常利用だけを止める最小のフェアユース上限。
    premiumSessionsPerDay: toInt(env.PREMIUM_SESSIONS_PER_DAY, 3),
    // 無料のお試しも品質を落とさず、設計の15〜20分を完走できる上端を既定値にする。
    freeSessionMaxSeconds: toInt(env.FREE_SESSION_MAX_SECONDS, 1200),
    premiumSessionMaxSeconds: toInt(env.PREMIUM_SESSION_MAX_SECONDS, 1200),
    betaOpenAccessUntil: toDate(env.BETA_OPEN_ACCESS_UNTIL),
    // 通常利用(1日1〜2回)には絶対に当たらず、原価の暴走だけを止める高さ。
    betaSessionsPerDay: toInt(env.BETA_SESSIONS_PER_DAY, 10),
  };
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 読めない値は `null` = **通常営業**に倒す。
 *
 * 打ち間違えた日付を「開放中」側へ倒すと、課金を止めたまま誰も気づかない。
 * 反対に倒れたときは、テスターが無料枠に当たって報告してくれる。
 */
function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
