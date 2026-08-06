import { fileURLToPath } from "node:url";
import { WorkerOptions, cli } from "@livekit/agents";
import * as Sentry from "@sentry/node";
import { setErrorReporter } from "./log.ts";

/**
 * エージェントのワーカー起動口。
 *
 *   npm run -w @ai-sensei/agent dev      # ローカルでルームを待ち受ける
 *   npm run -w @ai-sensei/agent start    # 本番
 *
 * 監視の配線はここだけ。**DSNが無ければ何も送らない**(ローカルは設定なしで動く)。
 * ジョブの節目のログは `log.ts`(1行1JSON)。
 */
const dsn = process.env["SENTRY_DSN"];
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env["ENVIRONMENT"] ?? "unknown",
    tracesSampleRate: 0,
    // 会話の中身・写真の要約は送らない。落ちた場所が分かれば足りる。
    sendDefaultPii: false,
  });
  setErrorReporter((error, context) => {
    Sentry.captureException(error, { extra: context });
  });
}

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(new URL("agent.ts", import.meta.url)),
  }),
);
