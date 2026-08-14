/**
 * Structured logs for the agent.
 *
 * This is where things break most quietly. Worker not running, dispatch not
 * arriving, karte LLM failing - the app shows only "senpai never came / no
 * board / no karte". One JSON per line, always recording job milestones.
 *
 * | event                        | when |
 * | ---------------------------- | --- |
 * | `job_started`                | job received (= dispatch did arrive) |
 * | `context_unreadable`         | context unreadable; hang up without talking |
 * | `conversation_started`       | session up (*before* the lesson) |
 * | `review_hole_missing`        | old-API review; degrade to a board-less conversation |
 * | `lesson_interrupted_by_user` | student spoke mid-lesson; stop the board, switch to conversation |
 * | `lesson_finished`            | one lesson done (step count, how it closed, rejections) |
 * | `lesson_empty`               | not one board line came out - the metric for the 8/16 gate |
 * | `board_publisher_missing`    | no Text Streams sink; continue conversation without a board |
 * | `say_failed`                 | playout failed (session closing, etc.) |
 * | `voice_metrics`              | SDK-collected latency, audio time, barge-in count; no content |
 * | `user_turn_transcribed`      | a student turn settled (interim count and length only) |
 * | `agent_false_interruption`   | whether a false barge-in was auto-resumed |
 * | `overlapping_speech`         | overlap detected (no raw audio or probability series) |
 * | `conversation_ended`         | how it ended (completed / timeout / user_left / error) |
 * | `karte_built`                | karte produced (hole count and duration) |
 * | `karte_failed`               | LLM or schema failed; an empty karte is sent |
 * | `complete_posted`            | `/complete` succeeded |
 * | `complete_failed`            | it did not - the only path where no karte surfaces |
 *
 * Board delivery itself (`board_opened` / `board_step_rejected` /
 * `board_lesson_overflow` ...) is logged by `board.ts` on the same `JobLogger`.
 */

export type LogFields = Record<string, unknown>;

export type ErrorReporter = (error: unknown, context: LogFields) => void;

/**
 * Sink for degradations. Kept separate from errors.
 *
 * `error` flows to `captureException` as a crash, but a degradation is "still
 * up, promise broken"; mixing them buries real crashes (plan §10-7, same split
 * as mobile's `telemetry.dart`).
 *
 * Which `warn`s count as degradations, and what is redacted, is decided in
 * `telemetry.ts`. This just forwards what arrives, keeping the send conditions
 * in one place.
 */
export type DegradationReporter = (event: string, fields: LogFields) => void;

let reporter: ErrorReporter | null = null;
let degradationReporter: DegradationReporter | null = null;

/** A sink such as Sentry. Injected by `index.ts` when a DSN exists. */
export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

export function setDegradationReporter(next: DegradationReporter | null): void {
  degradationReporter = next;
}

export class JobLogger {
  // No parameter properties. The agent runs .ts directly under
  // `node --experimental-strip-types` (ADR 0002), which only strips types, so
  // this one syntax - which also emits values - does not work.
  private readonly base: LogFields;
  private readonly sink: (line: string) => void;
  private readonly errorSink: (line: string) => void;

  constructor(
    base: LogFields = {},
    sink: (line: string) => void = console.log,
    errorSink: (line: string) => void = console.error,
  ) {
    this.base = base;
    this.sink = sink;
    this.errorSink = errorSink;
  }

  /** After the session context is read, make a child that adds session_id to every line. */
  child(fields: LogFields): JobLogger {
    return new JobLogger({ ...this.base, ...fields }, this.sink, this.errorSink);
  }

  info(event: string, fields: LogFields = {}): void {
    this.sink(this.line("info", event, fields));
  }

  warn(event: string, fields: LogFields = {}): void {
    this.sink(this.line("warn", event, fields));
    // Do nothing without a sink (always the case locally and in tests).
    degradationReporter?.(event, { ...this.base, ...fields });
  }

  error(event: string, error: unknown, fields: LogFields = {}): void {
    this.errorSink(this.line("error", event, { ...fields, ...describeError(error) }));
    reporter?.(error, { event, ...this.base, ...fields });
  }

  private line(level: string, event: string, fields: LogFields): string {
    return JSON.stringify({
      level,
      event,
      component: "agent",
      ...this.base,
      ...fields,
    });
  }
}

export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(error.stack === undefined ? {} : { error_stack: error.stack }),
    };
  }
  return { error_name: "NonError", error_message: String(error) };
}
