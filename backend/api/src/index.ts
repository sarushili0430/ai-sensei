import { captureException, captureMessage, withSentry } from "@sentry/cloudflare";
import { createApp } from "./app.ts";
import type { Bindings } from "./env.ts";
import {
  createDegradationReporter,
  setDegradationReporter,
  setErrorReporter,
} from "./lib/observability.ts";

/**
 * The worker's entry point.
 *
 * Monitoring is wired only here; `app.ts` stays plain Hono (so tests do not pull
 * in Sentry). Nothing is sent without a DSN, so local and CI work unconfigured.
 *
 * Two kinds are sent, and they must not share a shelf (plan §10-7):
 *
 *   - crash       ... `log.error()` -> `captureException`
 *   - degradation ... `log.warn()`  -> `captureMessage(level: "warning")`
 */
const app = createApp();

setErrorReporter((error, context) => {
  captureException(error, { extra: context });
});

setDegradationReporter(
  createDegradationReporter((event, fields) => {
    captureMessage(event, {
      level: "warning",
      // Lets us filter by kind (same tag name as the agent and mobile).
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
    // Errors only for now. Raise traces when they are actually needed (burning the
    // free tier on performance data would drop the errors that matter).
    tracesSampleRate: 0,
    // No photos, transcripts or device ids. The stack plus the structured logs'
    // trace_id is enough to say what happened.
    sendDefaultPii: false,

    /**
     * Drop `consoleIntegration`, which is on by default.
     *
     * This worker writes every structured log to `console.log`
     * (`observability.ts`). Left at the default, each of those JSON lines becomes
     * a breadcrumb, so every single error carries the preceding logs to Sentry -
     * the very lines emitted for `[observability]` would go straight out.
     *
     * The same trap as mobile's `enablePrintBreadcrumbs` (default true), waiting
     * on the server under a different name.
     */
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),

    /**
     * Last gate: whatever slipped past the above is dropped here (the twin of
     * mobile's `scrubEvent`). Drop the contents, never the whole event.
     * `request` carries the URL and headers - no body, but monitoring does not
     * need it.
     */
    beforeSend: (event) => {
      event.breadcrumbs = [];
      // biome-ignore lint/performance/noDelete: optional in the SDK types, so delete rather than send
      delete event.request;
      return event;
    },
  }),
  app,
);
