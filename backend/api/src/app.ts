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
  /** Hook for swapping dependencies from tests. */
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

  // One line per request, so "slow" and "failing" are visible from here alone.
  // trace_id also comes back in a response header, traceable from an app report.
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
      // Report the route pattern (so logs are not scattered by session id)
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

  // develop and production look identical, so return which one was hit
  // (a post-deploy smoke test then catches a mixed-up URL).
  app.get("/health", (c) => c.json({ ok: true, environment: c.env?.ENVIRONMENT ?? "unknown" }));

  // Anonymous device id (no account creation required).
  // Webhooks come from RevenueCat and are exempt from this auth.
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
    // Expected failures (free tier, unreadable photo, ...) are returned to the app
    // as-is. The middleware above logs status and error_code.
    if (error instanceof HTTPException) {
      return error.getResponse();
    }

    // Anything reaching here looks like internal_error to the app.
    // The cause exists only in the logs, so emit it with full context.
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
  // /complete from the agent enters with an internal token and has no device id
  // (/result is called by the app, which does need one)
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
