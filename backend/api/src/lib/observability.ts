/**
 * Makes what happened traceable after the fact.
 *
 * Cloudflare Workers Observability (`[observability]` in `wrangler.toml`) picks
 * up stdout as-is. One JSON per line lets the dashboard and `wrangler tail`
 * filter by field ("only photo_analysis_failed", "only this trace_id"). Mixing
 * in human-readable strings breaks that.
 *
 * Only three kinds are emitted. More would make it unclear what to look at.
 *
 * | event                | when |
 * | -------------------- | --- |
 * | `http_request`       | one line per request (result and duration) |
 * | `<something>_failed` | expected failures (unreadable photo, failed notification booking) |
 * | `unhandled_error`    | unexpected; the user got internal_error |
 *
 * Nothing personally identifying is logged. Device ids are anonymous but track
 * across a device, so only the first 8 characters are kept - enough to correlate.
 */

export type LogFields = Record<string, unknown>;

export type ErrorReporter = (error: unknown, context: LogFields) => void;

/**
 * An external sink such as Sentry. Injected by `index.ts` when a DSN exists.
 *
 * It is not imported directly so tests and route implementations stay plain.
 * With no sink, nothing happens (local development works without a DSN).
 */
let reporter: ErrorReporter | null = null;

export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

/**
 * The sink for degradations. Kept separate from errors (plan §10-7).
 *
 * `error` flows to `captureException` as a crash. This one is "still up but a
 * promise is broken" and goes to `captureMessage(level: "warning")`. Mixing them
 * buries real crashes. Same split as on mobile and in the agent.
 */
export type DegradationReporter = (event: string, fields: LogFields) => void;

let degradationReporter: DegradationReporter | null = null;

export function setDegradationReporter(next: DegradationReporter | null): void {
  degradationReporter = next;
}

/**
 * How much to emit.
 *
 * `error` drops the per-request line (`http_request`) and keeps only failures.
 * It is the escape hatch for when log volume becomes a problem; the default is
 * info (without seeing that nothing is wrong, you cannot notice it got slower).
 */
export type LogLevel = "info" | "error";

export function readLogLevel(env: { LOG_LEVEL?: string } | undefined): LogLevel {
  return env?.LOG_LEVEL === "error" ? "error" : "info";
}

/** A logger holding one request's context. Every line carries the same `trace_id`. */
export class RequestLogger {
  constructor(
    readonly traceId: string,
    private readonly base: LogFields = {},
    private readonly level: LogLevel = "info",
    private readonly sink: (line: string) => void = console.log,
  ) {}

  info(event: string, fields: LogFields = {}): void {
    if (this.level === "error") return;
    this.write("info", event, fields);
  }

  /**
   * Degradation reports are not silenced by `LOG_LEVEL`.
   *
   * `level: "error"` is an escape hatch for stdout volume, not a statement that
   * something need not be noticed. Silencing this too would cut monitoring
   * because of log volume - with no way to notice that it was cut.
   */
  warn(event: string, fields: LogFields = {}): void {
    // Do nothing without a sink (always the case locally and in tests).
    degradationReporter?.(event, { trace_id: this.traceId, ...this.base, ...fields });
    if (this.level === "error") return;
    this.write("warn", event, fields);
  }

  /**
   * Turns a failure into one line. Stacks appear nowhere else, so always route
   * through here. The same goes to the external sink (Sentry).
   */
  error(event: string, error: unknown, fields: LogFields = {}): void {
    const described = describeError(error);
    this.write("error", event, { ...fields, ...described });
    reporter?.(error, { event, trace_id: this.traceId, ...this.base, ...fields });
  }

  private write(level: string, event: string, fields: LogFields): void {
    this.sink(
      JSON.stringify({
        level,
        event,
        trace_id: this.traceId,
        ...this.base,
        ...fields,
      }),
    );
  }
}

/** Structures an error, without dying when something that is not an Error is thrown. */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(error.stack === undefined ? {} : { error_stack: error.stack }),
      ...(error.cause === undefined ? {} : { error_cause: String(error.cause) }),
    };
  }
  return { error_name: "NonError", error_message: String(error) };
}

/**
 * Only the head of a device id.
 *
 * Lining up requests from the same device is enough; the whole thing is not needed.
 */
export function deviceTag(deviceId: string | undefined): string | undefined {
  return deviceId ? deviceId.slice(0, 8) : undefined;
}

/** Picks the error code returned to the app out of a response (for log filtering). */
export async function errorCodeOf(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;
  if (!response.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } };
    const code = body.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export function newTraceId(): string {
  return crypto.randomUUID();
}

/* -------------------------------------------------------------------------- */
/* Degradations (the warns that are escalated to monitoring)                  */
/* -------------------------------------------------------------------------- */

/**
 * Degradations escalated to monitoring. Kept a closed set.
 *
 * Escalating every `warn` would send auth rejections (scanners hit them
 * constantly) and cause alert fatigue. The single criterion for inclusion is
 * "did the user lose out".
 *
 * Same thinking as the agent side (`backend/agent/src/telemetry.ts`), different
 * implementation. The runtime and SDK differ (`@sentry/node` /
 * `@sentry/cloudflare`), so it is not a shared package. What is kept aligned is
 * the policy (degradations are warnings, no content is sent, no key means no
 * action) - not the code.
 */
export const apiDegradations = [
  /**
   * The notes photo was unreadable, so the lesson starts with zero clues.
   * If this keeps rising, either the capture guidance or the analysis is failing.
   */
  "notes_photo_unreadable",
  /**
   * The problem photo was unreadable, so the senpai teaches without seeing the
   * problem and opens with "could you read the problem out?" (plan §4-1).
   */
  "problem_photo_unreadable",
  /**
   * The karte LLM attached an off-allow-list topic_id and we remapped it.
   * A degradation toward off-target review notifications, invisible on screen.
   */
  "guardrail_retagged_holes",
] as const;

export type ApiDegradation = (typeof apiDegradations)[number];

const degradationSet = new Set<string>(apiDegradations);

export function isDegradation(event: string): event is ApiDegradation {
  return degradationSet.has(event);
}

/**
 * Fields allowed to reach monitoring. Strings not listed here are dropped
 * (allow-list, not deny-list).
 *
 * Log fields will keep growing, so "enumerate the dangerous ones" would send new
 * fields by default. Default to dropping.
 */
export const degradationStringFields = [
  "trace_id",
  "session_id",
  "kind",
  "locale",
  /** Closed curriculum vocabulary (`packages/curriculum` ids). Not user input. */
  "retagged_to",
] as const;

const allowedStrings = new Set<string>(degradationStringFields);

/** The last gate that drops content before sending. Numbers and booleans pass; strings only if allow-listed. */
export function scrubFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string" && allowedStrings.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Throttling so the same thing is not sent repeatedly.
 *
 * Workers reuse isolates across requests, so state accumulates in-process. On
 * hitting the cap it forgets everything (over-sending is less bad than a
 * long-lived isolate going permanently silent).
 */
export class DegradationThrottle {
  private readonly limit: number;
  private readonly seen = new Set<string>();

  constructor(limit = 64) {
    this.limit = limit;
  }

  allow(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.limit) this.seen.clear();
    this.seen.add(key);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

/** The unit of "the same event". One per session. */
export function degradationKey(event: string, fields: LogFields): string {
  const scope = fields["session_id"];
  return `${event}/${typeof scope === "string" ? scope : ""}`;
}

export type CaptureDegradation = (event: ApiDegradation, fields: LogFields) => void;

/**
 * Builds the function that takes `RequestLogger.warn` and sends only the
 * degradations, throttled. Deciding, throttling and redacting all live here, so
 * `index.ts` only has to inject it.
 */
export function createDegradationReporter(
  capture: CaptureDegradation,
  throttle: DegradationThrottle = new DegradationThrottle(),
): DegradationReporter {
  return (event, fields) => {
    if (!isDegradation(event)) return;
    if (!throttle.allow(degradationKey(event, fields))) return;
    capture(event, scrubFields(fields));
  };
}
