import { captureException, captureMessage, withSentry } from "@sentry/cloudflare";
import { createApp } from "./app.ts";
import type { Bindings } from "./env.ts";
import {
  createDegradationReporter,
  setDegradationReporter,
  setErrorReporter,
} from "./lib/observability.ts";

/**
 * ワーカーの入口。
 *
 * 監視の配線はここだけで行う。`app.ts` は素のHonoのままにしておく
 * (テストがSentryを引き込まないように)。**DSNが無ければ何も送らない**ので、
 * ローカルとCIは設定なしで動く。
 *
 * 送るのは2種類。**同じ棚に置かない**(計画書 §10-7):
 *
 *   - クラッシュ … `log.error()` → `captureException`
 *   - **縮退**   … `log.warn()` → `captureMessage(level: "warning")`
 */
const app = createApp();

setErrorReporter((error, context) => {
  captureException(error, { extra: context });
});

setDegradationReporter(
  createDegradationReporter((event, fields) => {
    captureMessage(event, {
      level: "warning",
      // 種類ごとに絞れるようにする(agent・モバイルと同じタグ名で揃える)。
      tags: { degradation: event },
      extra: fields,
    });
  }),
);

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

    /**
     * **`consoleIntegration` を外す。既定で入っている。**
     *
     * このワーカーは構造化ログを**全部 `console.log`** に書く(`observability.ts`)。
     * 既定のままだと、その1行1JSONがそっくりパンくずになり、
     * **エラーが1件起きるたびに直前のログがまとめてSentryへ運ばれる**。
     * `[observability]` が拾うために出している行が、そのまま外へ出ていく形になる。
     *
     * モバイル側の `enablePrintBreadcrumbs`(既定 true)と同じ罠が、
     * サーバ側では `consoleIntegration` という別の名前で待っていた。
     */
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),

    /**
     * 最後の関門。上をすり抜けたものはここで落とす(モバイル側の `scrubEvent` と対)。
     * **イベントごと捨てない** — 落とすのは中身だけ。
     * `request` にはURLとヘッダが載る。本文は載らないが、監視に要らない。
     */
    beforeSend: (event) => {
      event.breadcrumbs = [];
      // biome-ignore lint/performance/noDelete: SDKの型では省略可能な欄なので消して送らない
      delete event.request;
      return event;
    },
  }),
  app,
);
