import { fileURLToPath } from "node:url";
import { WorkerOptions, cli } from "@livekit/agents";

/**
 * エージェントのワーカー起動口。
 *
 *   npm run -w @ai-sensei/agent dev      # ローカルでルームを待ち受ける
 *   npm run -w @ai-sensei/agent start    # 本番
 */
cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(new URL("agent.ts", import.meta.url)),
  }),
);
