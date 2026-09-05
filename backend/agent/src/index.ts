import { fileURLToPath } from "node:url";
import { WorkerOptions, cli } from "@livekit/agents";
import * as Sentry from "@sentry/node";
import { loadConfig } from "./config.ts";
import { setDegradationReporter, setErrorReporter } from "./log.ts";
import { createDegradationReporter, scrubFields, scrubMessage } from "./telemetry.ts";

/**
 * エージェントのワーカー起動口。
 *
 *   npm run -w @ai-sensei/agent dev      # ローカルでルームを待ち受ける
 *   npm run -w @ai-sensei/agent start    # 本番
 *
 * 監視の配線はここだけ。**DSNが無ければ何も送らない**(ローカルは設定なしで動く)。
 * ジョブの節目のログは `log.ts`(1行1JSON)、縮退の判定は `telemetry.ts`。
 *
 * 送るのは2種類。**同じ棚に置かない**(計画書 §10-7):
 *
 *   - クラッシュ … `log.error()` → `captureException`
 *   - **縮退**   … `log.warn()` → `captureMessage(level: "warning")`
 *
 * 落ちてはいないが約束が破れている状態をクラッシュに混ぜると、
 * 本当に落ちたものが埋もれる。
 */
const dsn = process.env["SENTRY_DSN"];
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env["ENVIRONMENT"] ?? "unknown",
    tracesSampleRate: 0,
    // 会話の中身・写真の要約は送らない。落ちた場所が分かれば足りる。
    sendDefaultPii: false,

    /**
     * **`consoleIntegration` を外す。既定で入っている。**
     *
     * このワーカーは構造化ログを**全部 `console.log`** に書く(`log.ts`)。
     * 既定のままだと、その1行1JSONがそっくりパンくずになり、
     * **エラーが1件起きるたびに直前のログがまとめてSentryへ運ばれる**。
     * その中には `board_opened` の `title`(= LLMが問題を見て書いた文字列)や
     * `board_step_rejected` の `detail` が入っている。
     *
     * モバイル側の `enablePrintBreadcrumbs`(既定 true)と同じ罠が、
     * サーバ側では `consoleIntegration` という別の名前で待っていた。
     */
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),

    /**
     * 最後の関門。上をすり抜けたものはここで落とす(モバイル側の `scrubEvent` と対)。
     * **イベントごと捨てない** — 落とすのは中身だけ。
     */
    beforeSend: (event) => {
      event.breadcrumbs = [];
      // biome-ignore lint/performance/noDelete: SDKの型では省略可能な欄なので消して送らない
      delete event.request;

      /**
       * **例外メッセージから秘密を落とす。**
       *
       * モバイル側は「LiveKit の例外は `toString()` に接続先URLやトークンの断片を
       * 含むことがある」ことに気づいて `runtimeType` だけにした。こちらは外部SDK
       * (LiveKit / Deepgram / Anthropic)の例外がそのまま `captureException` に載るので、
       * 同じものが飛びうる。クラス名とスタックは残す(サーバ側では唯一の手がかり)。
       */
      for (const value of event.exception?.values ?? []) {
        if (value.value !== undefined) value.value = scrubMessage(value.value);
      }
      if (event.message !== undefined && typeof event.message === "string") {
        event.message = scrubMessage(event.message);
      }
      return event;
    },
  });

  setErrorReporter((error, context) => {
    // 文脈も縮退と同じ許可リストで絞る。`log.error` の欄は今後も増えるので、
    // ここを素通しにすると、足された欄が既定でクラッシュ報告に乗る。
    Sentry.captureException(error, { extra: scrubFields(context) });
  });

  setDegradationReporter(
    createDegradationReporter((event, fields) => {
      Sentry.captureMessage(event, {
        level: "warning",
        // 種類ごとに絞れるようにする(モバイル側の `degradation` タグと揃える)。
        tags: { degradation: event },
        extra: fields,
      });
    }),
  );
}

/**
 * 環境変数は**ワーカーを起こす前に**見る。
 *
 * 設定を実際に使うのはジョブ側(`agent.ts`)だが、そこまで待つと、値が壊れている
 * ことに気づくのが「先輩が来ない」と言われたときになる。しかもフレームワークは
 * 起動中の例外を握り潰して `closing worker due to error.` としか出さないので、
 * **理由の分かる形で先に落とす**のがいちばん安い。
 *
 * `--help` や将来のサブコマンドまで巻き込まないよう、ワーカーを実際に起こす
 * ときだけ見る。
 */
if (process.argv.includes("start") || process.argv.includes("dev")) {
  loadConfig();
}

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(new URL("agent.ts", import.meta.url)),
  }),
);
