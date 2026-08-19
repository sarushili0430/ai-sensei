import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Bindings, Services } from "./env.ts";
import { apiError } from "./lib/errors.ts";
import { isValidDeviceId, newId } from "./lib/ids.ts";
import { createOneSignalScheduler, noopScheduler } from "./lib/notifications.ts";
import {
  RequestLogger,
  deviceTag,
  errorCodeOf,
  newTraceId,
  readLogLevel,
} from "./lib/observability.ts";
import { createAnthropicAnalyzer } from "./lib/photo-analysis.ts";
import { D1Repository } from "./repository/d1.ts";
import { completeRoute } from "./routes/complete.ts";
import { meRoute } from "./routes/me.ts";
import { planMeRoute, plansRoute } from "./routes/plans.ts";
import { sessionsRoute } from "./routes/sessions.ts";
import { webhooksRoute } from "./routes/webhooks.ts";

export type CreateAppOptions = {
  /** テストから依存を差し替えるためのフック。 */
  services?: (env: Bindings) => Services;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["content-type", "authorization", "x-device-id", "idempotency-key"],
    }),
  );

  // 全リクエストに1行。**遅い・落ちるがここだけで分かる**ようにしておく。
  // trace_id はレスポンスヘッダにも返すので、アプリ側の報告から辿れる。
  app.use("*", async (c, next) => {
    const traceId = newTraceId();
    const startedAt = Date.now();
    const log = new RequestLogger(
      traceId,
      { environment: c.env?.ENVIRONMENT ?? "unknown" },
      readLogLevel(c.env),
    );
    c.set("log", log);
    c.set("traceId", traceId);

    await next();

    c.res.headers.set("x-trace-id", traceId);
    log.info("http_request", {
      method: c.req.method,
      // ルートのパターンで出す(セッションIDでログが散らばらないように)
      route: c.req.routePath,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - startedAt,
      device: deviceTag(c.req.header("x-device-id")),
      error_code: await errorCodeOf(c.res),
    });
  });

  app.use("*", async (c, next) => {
    c.set("services", options.services?.(c.env) ?? defaultServices(c.env));
    await next();
  });

  // develop と production は見た目が同じなので、どちらに当たったかを返す
  // (デプロイ直後のスモークで、URLの取り違えに気づけるようにする)。
  app.get("/health", (c) => c.json({ ok: true, environment: c.env?.ENVIRONMENT ?? "unknown" }));

  // 匿名デバイスID(アカウント作成を要求しない)。
  // webhookはRevenueCatから来るので、この認証の対象外。
  app.use("/v1/sessions/*", deviceAuth);
  app.use("/v1/sessions", deviceAuth);
  app.use("/v1/me/*", deviceAuth);
  app.use("/v1/plans/*", deviceAuth);
  app.use("/v1/plans", deviceAuth);

  app.route("/v1/sessions", sessionsRoute);
  app.route("/v1/sessions", completeRoute);
  app.route("/v1/me", meRoute);
  app.route("/v1/webhooks", webhooksRoute);
  app.route("/v1/plans", plansRoute);
  app.route("/v1/me/plan", planMeRoute);

  app.onError((error, c) => {
    // 想定内の失敗(無料枠・写真が読めない等)は、そのままアプリへ返す。
    // 上のミドルウェアが status と error_code をログに残す。
    if (error instanceof HTTPException) {
      return error.getResponse();
    }

    // ここに来たものはアプリからは internal_error にしか見えない。
    // **原因はログにしか残らない**ので、文脈ごと出す。
    const log = c.get("log");
    const fields = {
      method: c.req.method,
      route: c.req.routePath,
      device: deviceTag(c.req.header("x-device-id")),
    };
    if (log) {
      log.error("unhandled_error", error, fields);
    } else {
      console.error(JSON.stringify({ level: "error", event: "unhandled_error", ...fields }), error);
    }

    const response = apiError("internal_error").getResponse();
    const traceId = c.get("traceId");
    if (traceId) response.headers.set("x-trace-id", traceId);
    return response;
  });

  return app;
}

const deviceAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // agentからの /complete と /context は内部トークンで入るため、デバイスIDを持たない。
  // どちらも各ルートで Bearer を検証する(/result はアプリなのでデバイスIDが要る)。
  if (c.req.path.endsWith("/complete") || c.req.path.endsWith("/context")) return next();

  const deviceId = c.req.header("x-device-id");
  if (!isValidDeviceId(deviceId)) throw apiError("unauthorized");
  c.set("deviceId", deviceId);
  await next();
};

function defaultServices(env: Bindings): Services {
  return {
    repository: new D1Repository(env.DB),
    analyzer: createAnthropicAnalyzer({
      apiKey: env.ANTHROPIC_API_KEY ?? "",
      model: env.LLM_MODEL_VISION ?? "claude-sonnet-5",
    }),
    scheduler:
      env.ONESIGNAL_APP_ID && env.ONESIGNAL_REST_API_KEY
        ? createOneSignalScheduler({
            appId: env.ONESIGNAL_APP_ID,
            restApiKey: env.ONESIGNAL_REST_API_KEY,
          })
        : noopScheduler,
    now: () => new Date(),
    newId: (prefix) => newId(prefix),
  };
}
