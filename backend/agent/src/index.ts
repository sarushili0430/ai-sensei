import { fileURLToPath } from "node:url";
import { WorkerOptions, cli } from "@livekit/agents";
import * as Sentry from "@sentry/node";
import { loadConfig } from "./config.ts";
import { setDegradationReporter, setErrorReporter } from "./log.ts";
import { createDegradationReporter, scrubFields, scrubMessage } from "./telemetry.ts";

/**
 * Worker entry point for the agent.
 *
 *   npm run -w @ai-sensei/agent dev      # listen for rooms locally
 *   npm run -w @ai-sensei/agent start    # production
 *
 * Monitoring is wired only here, and sends nothing without a DSN (local runs
 * work unconfigured). Job milestones go to `log.ts` (one JSON per line);
 * `telemetry.ts` decides what counts as a degradation.
 *
 * Two kinds are sent, and they must not share a shelf (plan §10-7):
 *
 *   - crash       ... `log.error()` -> `captureException`
 *   - degradation ... `log.warn()`  -> `captureMessage(level: "warning")`
 *
 * Folding "still up but breaking a promise" into crashes buries the things
 * that really crashed.
 */
const dsn = process.env["SENTRY_DSN"];
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env["ENVIRONMENT"] ?? "unknown",
    tracesSampleRate: 0,
    // Never send conversation content or photo summaries; where it broke is enough.
    sendDefaultPii: false,

    /**
     * Drop `consoleIntegration`, which is on by default.
     *
     * This worker writes every structured log to `console.log` (`log.ts`). Left
     * at the default, each of those JSON lines becomes a breadcrumb, so every
     * single error carries the preceding logs to Sentry - including
     * `board_opened`'s `title` (a string the LLM wrote from the problem photo)
     * and `board_step_rejected`'s `detail`.
     *
     * The same trap as mobile's `enablePrintBreadcrumbs` (default true), waiting
     * on the server under a different name.
     */
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),

    /**
     * Last gate: whatever slipped past the above is dropped here (the twin of
     * mobile's `scrubEvent`). Drop the contents, never the whole event.
     */
    beforeSend: (event) => {
      event.breadcrumbs = [];
      // biome-ignore lint/performance/noDelete: optional in the SDK types, so delete rather than send
      delete event.request;

      /**
       * Scrub secrets from exception messages.
       *
       * Mobile noticed that LiveKit exceptions can carry URL or token fragments
       * in `toString()` and kept only `runtimeType`. Here, exceptions from
       * external SDKs (LiveKit / Deepgram / Anthropic) reach `captureException`
       * verbatim, so the same can leak. Class name and stack are kept - on the
       * server they are the only clue.
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
    // Narrow context with the same allow-list as degradations. `log.error` will
    // keep gaining fields, and passing them through means new fields land in
    // crash reports by default.
    Sentry.captureException(error, { extra: scrubFields(context) });
  });

  setDegradationReporter(
    createDegradationReporter((event, fields) => {
      Sentry.captureMessage(event, {
        level: "warning",
        // Lets us filter by kind (matches mobile's `degradation` tag).
        tags: { degradation: event },
        extra: fields,
      });
    }),
  );
}

/**
 * Read env vars *before* waking the worker.
 *
 * The config is actually used by the job (`agent.ts`), but waiting that long
 * means finding out a value is broken only when someone says "senpai never
 * came". The framework also swallows startup exceptions and prints only
 * `closing worker due to error.`, so failing early with a readable reason is
 * by far the cheapest option.
 *
 * Checked only when actually waking the worker, so `--help` and future
 * subcommands are unaffected.
 */
if (process.argv.includes("start") || process.argv.includes("dev")) {
  loadConfig();
}

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(new URL("agent.ts", import.meta.url)),
  }),
);
