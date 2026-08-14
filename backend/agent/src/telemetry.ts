import type { LogFields } from "./log.ts";

/**
 * Degradation monitoring, the counterpart to `lib/src/telemetry/telemetry.dart`
 * on mobile.
 *
 * ## Why the agent needs its own
 *
 * The hole was asymmetric. Mobile reports "the board was truncated" and "a
 * formula fell below the minimum scale", but those are degradations as seen by
 * the receiver, and two cases are invisible from there:
 *
 *   1. The agent failed to send the board. The receiver only sees "it never came"
 *      and learns nothing about what happened on the sending side (failed
 *      validation, cut off at a limit, a failed send).
 *   2. A degradation before the receiver even starts. If it fails before
 *      generation begins, the thing that would report it does not exist.
 *
 * ## Crashes and degradations stay on separate shelves
 *
 * `JobLogger.error()` already flows to `captureException`. This handles states
 * that have not crashed but have broken a promise, and sends them to
 * `captureMessage(level: "warning")`. Mixing them into the crash shelf buries
 * real crashes.
 *
 * ## Never sent — the users are minors and problem text is someone else's work
 *
 * No student speech, transcripts, kartes or problem text. Problem text is what we
 * decided not to store even in R2, so letting it reach monitoring would void that
 * decision.
 *
 * Stripping works by allow list, not deny list. Log fields will keep being added,
 * and an "enumerate the dangerous ones" approach sends every new field by
 * default. Strings written by an LLM looking at the problem — `board_opened`'s
 * `title`, for instance — sit plainly in these fields, so the default must be to
 * drop.
 *
 * Sentry is not imported here, so tests do not pull in the SDK. The actual send
 * is injected by `index.ts` through {@link createDegradationReporter}.
 */

/**
 * Degradations raised to monitoring. A closed set.
 *
 * Raising every `JobLogger.warn` would also send warnings from normal operation
 * (a later heading discarded, an LLM miscount that was corrected) and cause alert
 * fatigue — the same failure shape as dropping `containsAnswerLeak` in #12, and
 * it only ever pushes towards missing the real anomalies.
 *
 * The single criterion for inclusion: did something that should have reached the
 * student fail to?
 */
export const agentDegradations = [
  /** A parse failure, envelope contract violation or failed send. */
  "board_append_failed",
  /**
   * The closing envelope could not be sent. To the receiver the board stays open,
   * so every later board in that session fails to appear (see `close` in
   * `board.ts`).
   */
  "board_close_failed",
  /** A step failed validation and could not be repaired; it never reached them. */
  "board_step_rejected",
  /** The root `}` was never reached: one explanation was cut off. */
  "board_stream_truncated",
  /** Read fully but no steps, or no heading: output violating the contract. */
  "board_lesson_empty",
  "board_head_missing",
  /** Cut off at a limit: 40 per board, 12 per output. */
  "board_steps_overflow",
  "board_lesson_overflow",
  /** Appending to a closed board: the caller's state tracking has drifted. */
  "board_append_after_close",
  /** The repair failed, or was not even JSON. */
  "board_step_repair_failed",
  "board_step_repair_unreadable",
  /**
   * A board would have started on an out-of-scope topic.
   *
   * It means senpai was about to teach something not in the photo, so if frequent
   * it is material for fixing the allowed-topics section of `senpai_board.*.md`.
   * The lesson continues even unrepaired, so it is a degradation, not a crash.
   */
  "board_topics_rejected",
  /** The heading repair failed, or was not even JSON. */
  "board_head_repair_failed",
  "board_head_repair_unreadable",
  /** No Text Streams publisher: the path where no board appears at all. */
  "board_publisher_missing",
  /** Review metadata from an older API: with no target gap it degrades to the previous board-less conversation. */
  "review_hole_missing",
  /** The lesson produced no board lines at all; a release-gate metric. */
  "lesson_empty",
  /** Speech failed: the board appeared but the audio alone was lost. */
  "say_failed",
  /** Automatic allocation failed and fell back to a template: the plan arrives, but the automation's quality is gone. */
  "plan_template_fallback",
] as const;

export type AgentDegradation = (typeof agentDegradations)[number];

const degradationSet = new Set<string>(agentDegradations);

export function isDegradation(event: string): event is AgentDegradation {
  return degradationSet.has(event);
}

/**
 * Fields that may be sent to monitoring. Any string not listed is dropped.
 *
 * "Which board, which step, which kind of failure" is enough to act on. The
 * details (`detail`, `message`, `title`) stay in stdout, so they can be pulled
 * with `lk agent logs` once you know where to look. Monitoring needs to make you
 * notice, not to carry the whole cause.
 */
export const degradationStringFields = [
  /** The log's heading; needed when sending an `error`'s context. */
  "event",
  "board_id",
  "session_id",
  "plan_session_id",
  "room",
  "job_id",
  /** An enum such as `latex` / `syntax` / `schema` or `text_in_math`; never free text. */
  "reason",
  "ended_reason",
  "kind",
  "locale",
  "error_name",
] as const;

const allowedStrings = new Set<string>(degradationStringFields);

/**
 * The last gate, stripping content immediately before sending.
 *
 * Numbers and booleans pass through (counts, positions, durations). Strings pass
 * only via the allow list. Arrays and objects are opaque, so they are dropped
 * whole.
 */
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
 * Throttling so the same thing is not sent repeatedly; the counterpart to
 * mobile's `DegradationThrottle`.
 *
 * A single lesson streams dozens of steps. Sending each would flood one session
 * and blur "happened once" against "happening constantly". One report per board
 * is enough to identify which board.
 */
export class DegradationThrottle {
  private readonly limit: number;
  private readonly seen = new Set<string>();

  /**
   * `limit` caps the remembered keys; remembering without bound makes this the
   * one thing that grows. On reaching it everything is forgotten, so each key
   * sends once more. Over-reporting beats a long-running worker going silent.
   */
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

/**
 * The unit of "same event". Board-related ones use `board_id`, one per board;
 * those without it (`board_publisher_missing` and the like) go per session.
 */
export function degradationKey(event: string, fields: LogFields): string {
  const scope = fields["board_id"] ?? fields["session_id"] ?? fields["plan_session_id"] ?? "";
  return `${event}/${typeof scope === "string" ? scope : ""}`;
}

/** The actual send. `index.ts` injects Sentry here. */
export type CaptureDegradation = (event: AgentDegradation, fields: LogFields) => void;

/**
 * Builds the function that takes `JobLogger.warn` and sends only throttled
 * degradations.
 *
 * Selection, throttling and redaction all live here. `log.ts` says only "pass on
 * a warn", so changing what gets sent means touching one place.
 */
export function createDegradationReporter(
  capture: CaptureDegradation,
  throttle: DegradationThrottle = new DegradationThrottle(),
): (event: string, fields: LogFields) => void {
  return (event, fields) => {
    if (!isDegradation(event)) return;
    if (!throttle.allow(degradationKey(event, fields))) return;
    capture(event, scrubFields(fields));
  };
}

/* -------------------------------------------------------------------------- */
/* Exception messages                                                         */
/* -------------------------------------------------------------------------- */

/** How much of an exception message may be sent; the kind is enough. */
export const messageMaxLength = 200;

/**
 * URLs are truncated to scheme and host.
 *
 * Secrets ride in the path and query (`?access_token=`, signed URLs), so those
 * are dropped. The host stays — knowing which service failed is needed.
 */
const urlPattern = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#]+)[^\s]*/gi;

/**
 * Token-shaped runs: JWTs, API keys, base64 fragments. It collapses runs of 16 or
 * more characters made only of alphanumerics and `-_.`, so Japanese prose and
 * formulas are not caught.
 */
const tokenPattern = /\b[A-Za-z0-9_-]{16,}\.?[A-Za-z0-9_-]*\b/g;

/**
 * Strips secrets from an exception message.
 *
 * The server-side version of a trap mobile hit: it noticed that LiveKit
 * exceptions can carry endpoint URLs and token fragments in `toString()` and
 * reduced them to `runtimeType`. Here, exceptions from external SDKs (LiveKit,
 * Deepgram, Anthropic) reach `captureException` directly, so the same things can
 * escape.
 *
 * But the kind is not thrown away: on the server the stack is the only handle, so
 * the class name and stack stay and only the message's contents are scrubbed.
 *
 * Messages we assemble ourselves can also embed an API response body ("failed:
 * <status> <body>" in `lesson.ts` / `karte.ts`), which may contain LLM output, so
 * it is capped by length too.
 */
export function scrubMessage(message: string): string {
  const redacted = message.replace(urlPattern, "$1/…").replace(tokenPattern, "…");
  return redacted.length <= messageMaxLength ? redacted : `${redacted.slice(0, messageMaxLength)}…`;
}
