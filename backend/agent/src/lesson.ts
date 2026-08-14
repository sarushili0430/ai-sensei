import type { BoardStep, CompleteSessionRequest } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import type {
  AppendBoardOptions,
  BoardAppendResult,
  BoardCloseReason,
  BoardHeadRejection,
  BoardStepRejection,
} from "./board.ts";
import { extractJson } from "./karte.ts";
import type { JobLogger } from "./log.ts";
import { handsTurnToStudent } from "./senpai.ts";

/**
 * Phase 1, the lesson: generating the board lesson and delivering and speaking
 * it step by step.
 *
 * The board's plumbing is `board.ts` (envelopes, seq, lifetime) and its parsing
 * is `board-stream.ts`. This file holds only the upstream side joining those two
 * to Anthropic's streaming:
 *
 *   Anthropic SSE -> text chunks -> BoardDelivery.append() -> speak via onStep
 *
 * It does not depend on LiveKit's types ({@link RunBoardLessonOptions.speak} is
 * the thin seam). Staying testable without real keys is the same policy as
 * `board.ts`.
 */

/**
 * Token cap for one board lesson.
 *
 * Twelve steps (`boardLessonStepsMaxCount`) of `speech` up to 120 characters and
 * `tex` up to 200 is only a few KB of JSON. Japanese runs over one token per
 * character, so 4000 leaves room. Set too low it hits `max_tokens` partway
 * through `steps`, never reaches the root `}` and becomes
 * `board_stream_truncated`.
 */
export const boardLessonMaxTokens = 4000;

/** A repair covers one step; it must not use the whole lesson's budget. */
export const boardRepairMaxTokens = 600;

/**
 * Time cap for one stream.
 *
 * Holding a connection that never answers leaves the board frozen in front of the
 * student. It must stay under the session limit (5 minutes on the free tier), or
 * the session ends before the cut-off fires.
 */
export const boardStreamTimeoutMs = 60_000;

export type LessonStreamInput = {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
};

/**
 * The LLM that emits the board. Streaming only.
 *
 * There is no batch entry point, so no path exists back to the rejected option of
 * generating everything before playing it. Repairs ({@link StepRepair}) use the
 * same entry point, with the caller accumulating the emitted text.
 */
export type LessonLlm = {
  stream(input: LessonStreamInput): AsyncIterable<string>;
};

export type AnthropicLessonOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Extracts only the text deltas from the Anthropic Messages API's SSE stream.
 *
 * Written with plain `fetch`, like `createAnthropicClient` in `karte.ts`. The
 * official SDK is not used because `@anthropic-ai/sdk` is not among
 * `backend/agent`'s dependencies (`package.json` is outside this change's scope).
 * Adding it would be worth the swap.
 *
 * `thinking` is explicitly disabled. On models where adaptive thinking is on by
 * default (Sonnet 5 and the like), the whole thinking time lands before the first
 * step appears. That wait is exactly the "silence at the start" hole named in the
 * plan, and on the board silence equals generation time. When changing models,
 * check that the version accepts `thinking: {type: "disabled"}` (older ones may
 * not). `output_config.effort` is not sent: some models reject it, and losing a
 * whole lesson to a single model-name change is not worth it.
 */
export function createAnthropicLessonClient(options: AnthropicLessonOptions): LessonLlm {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const timeoutMs = options.timeoutMs ?? boardStreamTimeoutMs;

  return {
    async *stream({ system, user, maxTokens, signal }) {
      // Both an interruption and the time cap drop the HTTP connection. Releasing
      // the iterator alone leaves it alive, still paying for output tokens on a
      // board nobody will hear.
      const deadline = AbortSignal.timeout(timeoutMs);
      const aborter = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

      const response = await doFetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: maxTokens,
          stream: true,
          thinking: { type: "disabled" },
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: aborter,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`板書の生成に失敗しました: ${response.status} ${detail}`);
      }
      if (response.body === null) {
        throw new Error("板書の生成にレスポンス本文がありません");
      }

      yield* readTextDeltas(response.body);
    },
  };
}

/**
 * Streams only `text_delta` text out of the SSE byte stream.
 *
 * It does not wait for the event separator (a blank line). Anthropic's SSE puts
 * one `data:` line per event, so the contents are complete once the line closes.
 * Waiting for the blank line would spend, one line at a time, the latency
 * `board-stream.ts` earned by emitting each step as it closes.
 *
 * Chunks split mid-line (`decode(..., { stream: true })` spans multibyte
 * characters). The remainder simply carries over in a buffer; like the downstream
 * parser, chunk boundaries get no special treatment.
 */
export async function* readTextDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const text = textOfSseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (text !== null) yield text;
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    // Release the upstream on an interruption too (the HTTP side is already cut
    // via `signal`).
    reader.releaseLock();
  }
}

/**
 * Reads one SSE line: the contents if it is a text delta, otherwise `null`.
 *
 * A malformed `data:` line throws rather than being swallowed. Skipping it
 * silently would let the board "complete" one step short (the same reason
 * `board-stream.ts` checks the element type of `steps`).
 */
function textOfSseLine(line: string): string | null {
  const trimmed = line.trim();
  // `event:` lines, blank lines and `: ping` comments are dropped here.
  if (!trimmed.startsWith("data:")) return null;

  const payload = trimmed.slice("data:".length).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `板書のSSEが読めません: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof event !== "object" || event === null) return null;
  const typed = event as { type?: unknown; delta?: unknown; error?: unknown };

  if (typed.type === "error") {
    const detail = typed.error as { message?: unknown } | undefined;
    throw new Error(
      `板書の生成がエラーで止まりました: ${
        typeof detail?.message === "string" ? detail.message : JSON.stringify(typed.error)
      }`,
    );
  }

  if (typed.type !== "content_block_delta") return null;
  const delta = typed.delta as { type?: unknown; text?: unknown } | undefined;
  if (delta?.type !== "text_delta" || typeof delta.text !== "string") return null;
  return delta.text;
}

/** The instruction to produce a board, in the system prompt's language; mixing them makes the output language wobble. */
const lessonInstruction: Record<CurriculumLocale, string> = {
  // It does not say "the problem": a review has no photo and re-teaches the
  // previous gap itself.
  ja: "この授業の板書レッスンのJSONだけを返してください。",
  en: "Return only the board lesson JSON for this lesson.",
};

/**
 * The instruction for redoing a failed step.
 *
 * It states "one step only" explicitly. Returning a whole lesson shape
 * (`{title, topic_ids, steps}`) here always fails again, because `validateStep`
 * checks against `boardStepSchema`.
 */
const repairInstruction: Record<CurriculumLocale, (rejection: BoardStepRejection) => string> = {
  ja: (rejection) =>
    [
      "直前の板書の手順が検証に落ちました。**その手順1つだけ**を書き直してください。",
      "返すのは手順1つのJSONオブジェクト(`index` / `speech` / `board`)だけです。",
      "配列にしない、前置きを書かない、コードフェンスで囲まない。",
      // Blocks the repair from taking the cheapest path (the same reason as
      // schemaGuidance in `board.ts`).
      "**`board` を `null` にして逃げないこと。**書くはずだったものを消すと、この手順は板書に何も残しません。",
      "",
      `落ちた理由: ${rejection.guidance}`,
      `落ちた手順: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
  en: (rejection) =>
    [
      "The board step below failed validation. Rewrite **only that one step**.",
      "Return a single step JSON object (`index` / `speech` / `board`) and nothing else.",
      "No array, no preamble, no code fence.",
      "**Do not fall back to `board: null`** — dropping it leaves nothing on the board for this step.",
      "",
      `Why it failed: ${rejection.guidance}`,
      `The step that failed: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
};

/**
 * The instruction when a board would start on an out-of-scope topic.
 *
 * Only the heading is redone. Returning a whole lesson here would duplicate steps
 * already parsed (the heading closes before `steps`, so no step has been emitted
 * yet).
 */
const headRepairInstruction: Record<CurriculumLocale, (rejection: BoardHeadRejection) => string> = {
  ja: (rejection) =>
    [
      "板書の見出しが、このセッションの許可トピックから外れています。**見出しだけ**を書き直してください。",
      "返すのは `title` と `topic_ids` だけのJSONオブジェクト1つです。",
      "`steps` は入れない、前置きを書かない、コードフェンスで囲まない。",
      "",
      `直す理由: ${rejection.guidance}`,
      `落ちた見出し: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
  en: (rejection) =>
    [
      "The board title is outside the allowed topics for this session. Rewrite **only the head**.",
      "Return a single JSON object with just `title` and `topic_ids`.",
      "No `steps`, no preamble, no code fence.",
      "",
      `Why: ${rejection.guidance}`,
      `The head that failed: ${JSON.stringify(rejection.raw)}`,
    ].join("\n"),
};

/** Only the parts of one board (from `BoardChannel.startBoard()`) a lesson uses. */
export type BoardLessonDelivery = {
  append(options: AppendBoardOptions): Promise<BoardAppendResult>;
};

export type RunBoardLessonOptions = {
  llm: LessonLlm;
  /** The output of `boardLessonSystemPrompt()`. */
  system: string;
  locale: CurriculumLocale;
  delivery: BoardLessonDelivery;
  /**
   * Called right after one board line goes out; hand it to TTS here.
   *
   * The next step is not sent until it returns (the `onStep` contract in
   * `board.ts`). Waiting for speech to finish versus firing and returning changes
   * the synchronization granularity; that call is `agent.ts`'s.
   */
  speak: (step: BoardStep) => Promise<void>;
  signal?: AbortSignal;
  log?: Pick<JobLogger, "info" | "warn">;
  maxTokens?: number;
};

export type BoardLessonResult = BoardAppendResult & {
  /** Steps actually put on the wire; material for the teach-back prompt. */
  steps: BoardStep[];
};

/**
 * Streams one board lesson.
 *
 * Each step is sent as `board_step` the moment it closes, and spoken immediately
 * after sending. Reversed, "look here" points at an empty surface.
 *
 * It does not close the board. Its lifetime is one problem, and it stays on
 * screen through the teach-back; `agent.ts` closes it when the session ends.
 */
export async function runBoardLesson(options: RunBoardLessonOptions): Promise<BoardLessonResult> {
  const {
    llm,
    system,
    locale,
    delivery,
    speak,
    signal,
    log,
    maxTokens = boardLessonMaxTokens,
  } = options;

  const steps: BoardStep[] = [];

  const result = await delivery.append({
    chunks: llm.stream({ system, user: lessonInstruction[locale], maxTokens, signal }),
    signal,
    onStep: async (step) => {
      steps.push(step);
      // Do not speak after an interruption. The board is already out and is not
      // erased, but there is no reason to talk over a student who has started.
      if (signal?.aborted === true) return;
      await speak(step);
    },
    // Ask, then stop and wait for the answer. The prompt's "end the board once a
    // question is asked" is enforced here rather than left to generation wobble
    // (see `stopAfter` in `board.ts` for why the judgement does not live there).
    stopAfter: (step) => handsTurnToStudent(step.speech, locale),
    repair: (rejection) => repairStep({ llm, system, locale, rejection, signal, log }),
    repairHead: (rejection) =>
      askForJson({
        llm,
        system,
        user: headRepairInstruction[locale](rejection),
        signal,
        log,
        what: "board_head_repair",
        index: 0,
      }),
  });

  return { ...result, steps };
}

/**
 * Redoes one failed step, returning `null` when it cannot be repaired (the
 * explanation stops there).
 *
 * The wait here surfaces directly as silence (design decision 2 in `board.ts`),
 * so `maxTokens` is scoped to a single step and the default retry count stays 1.
 */
async function repairStep(input: {
  llm: LessonLlm;
  system: string;
  locale: CurriculumLocale;
  rejection: BoardStepRejection;
  signal?: AbortSignal;
  log?: Pick<JobLogger, "info" | "warn">;
}): Promise<unknown> {
  const { llm, system, locale, rejection, signal, log } = input;
  return askForJson({
    llm,
    system,
    user: repairInstruction[locale](rejection),
    signal,
    log,
    what: "board_step_repair",
    index: rejection.index,
    reason: rejection.reason,
  });
}

/**
 * Asks the LLM for a repair and extracts one JSON value; shared by steps and
 * headings.
 *
 * Returns `null` on failure and does not persist: failing means the phrasing does
 * not respond to the instruction, and repeating it lands in the same family of
 * failures.
 */
async function askForJson(input: {
  llm: LessonLlm;
  system: string;
  user: string;
  signal?: AbortSignal;
  log?: Pick<JobLogger, "info" | "warn">;
  /** Log heading prefix (`board_step_repair` / `board_head_repair`). */
  what: string;
  index: number;
  reason?: string;
}): Promise<unknown> {
  const { llm, system, user, signal, log, what, index, reason } = input;

  let raw = "";
  try {
    for await (const chunk of llm.stream({
      system,
      user,
      maxTokens: boardRepairMaxTokens,
      signal,
    })) {
      raw += chunk;
    }
  } catch (error) {
    log?.warn(`${what}_failed`, {
      index,
      ...(reason === undefined ? {} : { reason }),
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  try {
    return extractJson(raw);
  } catch {
    log?.warn(`${what}_unreadable`, {
      index,
      ...(reason === undefined ? {} : { reason }),
    });
    return null;
  }
}

/**
 * Translates how the session ended into how the board closes.
 *
 * `timeout` maps to `completed` because the time limit is the server's planned
 * ending. The board's `reason` is the receiver's marker for "did this break
 * partway", so putting `error` here would make every session that used its full
 * 15 minutes look like a failure.
 */
export function boardCloseReasonFor(
  reason: CompleteSessionRequest["ended_reason"],
): BoardCloseReason {
  switch (reason) {
    case "completed":
    case "timeout":
      return "completed";
    case "user_left":
      return "interrupted";
    default:
      return "error";
  }
}
