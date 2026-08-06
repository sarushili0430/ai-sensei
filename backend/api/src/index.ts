import { captureException, withSentry } from "@sentry/cloudflare";
import { createApp } from "./app.ts";
import type { Bindings } from "./env.ts";
import { setErrorReporter } from "./lib/observability.ts";

/**
 * ワーカーの入口。
 *
 * 監視の配線はここだけで行う。`app.ts` は素のHonoのままにしておく
 * (テストがSentryを引き込まないように)。**DSNが無ければ何も送らない**ので、
 * ローカルとCIは設定なしで動く。
 */
const app = createApp();

setErrorReporter((error, context) => {
  captureException(error, { extra: context });
});

export default withSentry(
  (env: Bindings) => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.ENVIRONMENT ?? "unknown",
    // まずはエラーだけ。トレースは要るようになってから上げる
    // (無料枠を性能計測で使い切ると、肝心のエラーが落ちる)。
    tracesSampleRate: 0,
    // 写真・トランスクリプト・デバイスIDを送らない。
    // 何が起きたかはスタックと構造化ログの trace_id で足りる。
    sendDefaultPii: false,
  }),
  app,
);
