import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Bindings, Services } from "./env.ts";
import { apiError } from "./lib/errors.ts";
import { isValidDeviceId, newId } from "./lib/ids.ts";
import { createOneSignalScheduler, noopScheduler } from "./lib/notifications.ts";
import { createAnthropicAnalyzer } from "./lib/photo-analysis.ts";
import { D1Repository } from "./repository/d1.ts";
import { completeRoute } from "./routes/complete.ts";
import { meRoute } from "./routes/me.ts";
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
    cors({ origin: "*", allowHeaders: ["content-type", "authorization", "x-device-id"] }),
  );

  app.use("*", async (c, next) => {
    c.set("services", options.services?.(c.env) ?? defaultServices(c.env));
    await next();
  });

  // develop と production は見た目が同じなので、どちらに当たったかを返す
  // (デプロイ直後のスモークで、URLの取り違えに気づけるようにする)。
  app.get("/health", (c) => c.json({ ok: true, environment: c.env?.ENVIRONMENT ?? "unknown" }));

  // 匿名デバイスID(handoff §5: アカウント作成を要求しない)。
  // webhookはRevenueCatから来るので、この認証の対象外。
  app.use("/v1/sessions/*", deviceAuth);
  app.use("/v1/sessions", deviceAuth);
  app.use("/v1/me/*", deviceAuth);

  app.route("/v1/sessions", sessionsRoute);
  app.route("/v1/sessions", completeRoute);
  app.route("/v1/me", meRoute);
  app.route("/v1/webhooks", webhooksRoute);

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    console.error("[api] 未処理のエラー", error);
    return apiError("internal_error").getResponse();
  });

  return app;
}

const deviceAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // agentからの /complete は内部トークンで入るため、デバイスIDを持たない
  // (/result はアプリが呼ぶので、デバイスIDが要る)
  if (c.req.path.endsWith("/complete")) return next();

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
