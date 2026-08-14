import type { BoardChannelMessage } from "@ai-sensei/contract";
import { boardChannelLogSchema } from "@ai-sensei/contract";
import { describe, expect, it, vi } from "vitest";
import { BoardChannel, type BoardSink } from "./board.ts";
import {
  type BoardLessonDelivery,
  type LessonLlm,
  boardCloseReasonFor,
  createAnthropicLessonClient,
  readTextDeltas,
  runBoardLesson,
} from "./lesson.ts";

/**
 * Tests for the lesson phase. Three things:
 *
 *   1. SSE becomes text deltas regardless of chunk boundaries
 *   2. the "board first, then speak" order holds for every step (§3-2)
 *   3. barge-in, validation failure and empty output never close the board
 *      (its lifetime is one problem)
 */

/* -------------------------------------------------------------------------- */
/* SSE                                                                        */
/* -------------------------------------------------------------------------- */

function deltaEvent(text: string): string {
  const payload = JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  return `event: content_block_delta\ndata: ${payload}\n\n`;
}

/** Split on bytes. Real networks cut in the middle of a multi-byte character. */
function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) parts.push(bytes.slice(at, at + size));
  return parts;
}

function bodyOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

describe("readTextDeltas", () => {
  it("text_delta だけを取り出す", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      ": ping\n\n",
      deltaEvent('{"title":"判別式"'),
      deltaEvent(',"steps":[]}'),
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    expect(await collect(readTextDeltas(bodyOf(byteChunks(sse, 4096))))).toBe(
      '{"title":"判別式","steps":[]}',
    );
  });

  // Chunks can split mid-line and mid-character. When this breaks, mojibake
  // lands in the board JSON and the whole scan dies.
  it("マルチバイトの途中で切れても壊れない", async () => {
    const sse = deltaEvent("判別式で解の個数を見る") + deltaEvent("、を板書に出す");

    expect(await collect(readTextDeltas(bodyOf(byteChunks(sse, 3))))).toBe(
      "判別式で解の個数を見る、を板書に出す",
    );
  });

  // Waiting will not fix it, so throw instead of skipping silently (the caller closes with error).
  it("APIのエラーイベントは理由を付けて投げる", async () => {
    const sse = `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    })}\n\n`;

    await expect(collect(readTextDeltas(bodyOf(byteChunks(sse, 4096))))).rejects.toThrow(
      /Overloaded/,
    );
  });

  // Skipping it would complete the board with one step missing
  it("壊れた data 行は握り潰さない", async () => {
    const sse = "data: {これはJSONではない}\n\n";

    await expect(collect(readTextDeltas(bodyOf(byteChunks(sse, 4096))))).rejects.toThrow(
      /板書のSSE/,
    );
  });
});

describe("createAnthropicLessonClient", () => {
  function stubFetch(sse: string) {
    return vi.fn(async () => new Response(bodyOf(byteChunks(sse, 4096)), { status: 200 }));
  }

  it("ストリーミングで呼び、thinking を切る", async () => {
    const fetchImpl = stubFetch(deltaEvent("{}"));

    const text = await collect(
      createAnthropicLessonClient({
        apiKey: "sk-test",
        model: "claude-sonnet-5",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).stream({ system: "s", user: "u", maxTokens: 100 }),
    );

    expect(text).toBe("{}");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    // On models with adaptive thinking by default, thinking time becomes opening silence
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.model).toBe("claude-sonnet-5");
  });

  // Releasing the iterator alone leaves the connection open, still paying for board tokens nobody hears
  it("割り込みのシグナルをHTTPまで通す", async () => {
    const fetchImpl = stubFetch(deltaEvent("{}"));
    const interrupt = new AbortController();

    await collect(
      createAnthropicLessonClient({
        apiKey: "sk-test",
        model: "claude-sonnet-5",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).stream({ system: "s", user: "u", maxTokens: 100, signal: interrupt.signal }),
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    interrupt.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it("APIが失敗したら理由を付けて投げる", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));

    await expect(
      collect(
        createAnthropicLessonClient({
          apiKey: "sk-test",
          model: "claude-sonnet-5",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }).stream({ system: "s", user: "u", maxTokens: 100 }),
      ),
    ).rejects.toThrow(/429/);
  });
});

/* -------------------------------------------------------------------------- */
/* Lesson delivery                                                            */
/* -------------------------------------------------------------------------- */

const step = (index: number, tex: string): unknown => ({
  index,
  speech: `${index}番目。ここ、見てほしいんだけど。`,
  board: { kind: "latex", tex },
});

function lessonJson(steps: readonly unknown[]): string {
  return JSON.stringify({
    title: "判別式で解の個数を見る",
    topic_ids: ["M1-NIJI-HANBETSU"],
    steps,
  });
}

/** An LLM that returns one output. Records the `user` message it was asked. */
function stubLlm(...outputs: readonly string[]): LessonLlm & { asked: string[] } {
  const asked: string[] = [];
  let call = 0;
  return {
    asked,
    stream({ user }) {
      asked.push(user);
      const output = outputs[Math.min(call, outputs.length - 1)] ?? "";
      call += 1;
      return (async function* () {
        // Yield to the event loop between chunks, like a real stream
        for (const part of output.match(/[\s\S]{1,7}/g) ?? []) {
          await Promise.resolve();
          yield part;
        }
      })();
    },
  };
}

function recordingSink(): BoardSink & { sent: BoardChannelMessage[] } {
  const sent: BoardChannelMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

function channelWith(sink: BoardSink): BoardChannel {
  let issued = 0;
  return new BoardChannel({
    sessionId: "ses_1",
    locale: "ja",
    sink,
    newBoardId: () => {
      issued += 1;
      return `brd_${issued}`;
    },
  });
}

describe("runBoardLesson", () => {
  // The order from §3-2. Reversed, "look here" points at an empty surface.
  it("板書を送ってから喋る、を手順ごとに繰り返す", async () => {
    // Push sends and playouts onto the same list to check they alternate
    const trace: string[] = [];
    const board = channelWith({
      async send(message) {
        trace.push(message.type === "board_step" ? `board:${message.step.index}` : message.type);
      },
    }).startBoard();

    const result = await runBoardLesson({
      llm: stubLlm(lessonJson([step(0, "x^2 - 3x + 2 = 0"), step(1, "D = 9 - 8 = 1")])),
      system: "先輩の板書プロンプト",
      locale: "ja",
      delivery: board,
      speak: async (delivered) => {
        trace.push(`speech:${delivered.index}`);
      },
    });

    expect(trace).toEqual(["board_open", "board:0", "speech:0", "board:1", "speech:1"]);
    expect(result.steps.map((delivered) => delivered.index)).toEqual([0, 1]);
    expect(result.reason).toBe("completed");
  });

  /**
   * Turn taking is enforced here, not merely wished for by the prompt.
   *
   * The board prompt says "once you ask a question, end that board; do not
   * continue `steps`", but one wobble in generation reads out 12 steps in a
   * single breath, question included. To the student the senpai keeps talking
   * while answering their own question (the 2026-08-12 "turn taking not held"
   * report).
   */
  it("問いかけたらそこで止めて、残りの手順は板書にも音声にも出さない", async () => {
    const spoken: number[] = [];
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    const result = await runBoardLesson({
      llm: stubLlm(
        lessonJson([
          step(0, "x^2 - 3x + 2 = 0"),
          { index: 1, speech: "a、b、c がどれか、言ってみて。", board: null },
          step(2, "D = 9 - 8 = 1"),
          step(3, "x = 1, 2"),
        ]),
      ),
      system: "s",
      locale: "ja",
      delivery: board,
      speak: async (delivered) => {
        spoken.push(delivered.index);
      },
    });

    // Deliver up to the question. Anything past it waits for the student's answer.
    expect(spoken).toEqual([0, 1]);
    expect(result.step_count).toBe(2);
    // Nothing broke; the turn was handed over as planned.
    expect(result.reason).toBe("completed");
  });

  it("疑問符で終わる第一声でも止まる(問題文が読めなかった授業の入口)", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    const result = await runBoardLesson({
      llm: stubLlm(
        lessonJson([
          { index: 0, speech: "問題、読んでもらってもいい?", board: null },
          step(1, "x^2 - 3x + 2 = 0"),
        ]),
      ),
      system: "s",
      locale: "ja",
      delivery: board,
      speak: async () => {},
    });

    expect(result.step_count).toBe(1);
    expect(result.reason).toBe("completed");
  });

  // A board lives for one problem. If it does not survive teach-back, what they explain disappears.
  it("授業が終わっても板書は閉じない", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await runBoardLesson({
      llm: stubLlm(lessonJson([step(0, "x^2 - 3x + 2 = 0")])),
      system: "s",
      locale: "ja",
      delivery: board,
      speak: async () => undefined,
    });

    expect(board.isClosed).toBe(false);
    expect(sink.sent.some((message) => message.type === "board_close")).toBe(false);
  });

  it("送った列がそのまま契約(seq / index / 順序)を満たす", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await runBoardLesson({
      llm: stubLlm(lessonJson([step(0, "D = b^2 - 4ac"), step(1, "= 9 - 8 = 1")])),
      system: "s",
      locale: "ja",
      delivery: board,
      speak: async () => undefined,
    });
    await board.close("completed");

    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  // The wiring that has failed steps rebuilt. Without it, one unrenderable
  // formula stops that entire explanation.
  it("落ちた手順は理由を添えて作り直させ、直ったものを送る", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();
    // Japanese inside math renders as black bars on the device (plan §3-6d)
    const llm = stubLlm(
      lessonJson([step(0, "\\text{よって} x = 2")]),
      JSON.stringify({
        index: 0,
        speech: "よって、こう。",
        board: { kind: "text", body: "x = 2" },
      }),
    );

    const result = await runBoardLesson({
      llm,
      system: "s",
      locale: "ja",
      delivery: board,
      speak: async () => undefined,
    });

    expect(result.rejections.map((rejection) => rejection.reason)).toEqual(["text_in_math"]);
    expect(result.step_count).toBe(1);
    expect(result.steps[0]?.board).toEqual({ kind: "text", body: "x = 2" });
    // The repair request carries the failure reason (the guardrail's guidance) verbatim
    expect(llm.asked[1]).toContain("text の板書として送る");
  });

  it("作り直しがJSONでなければ諦めて、板書は開いたまま残す", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    const result = await runBoardLesson({
      llm: stubLlm(lessonJson([step(0, "\\text{よって} x = 2")]), "うまく作れませんでした"),
      system: "s",
      locale: "ja",
      delivery: board,
      speak: async () => undefined,
    });

    expect(result.reason).toBe("error");
    expect(result.step_count).toBe(0);
    // Not one step settled, so not even board_open is sent (never blank the previous board)
    expect(sink.sent).toEqual([]);
    expect(board.isClosed).toBe(false);
  });

  it("割り込むと、その先の手順は板書にも音声にも出ない", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();
    const interrupt = new AbortController();

    const result = await runBoardLesson({
      llm: stubLlm(lessonJson([step(0, "x^2 = 4"), step(1, "x = 2"), step(2, "x = -2")])),
      system: "s",
      locale: "ja",
      delivery: board,
      signal: interrupt.signal,
      speak: async () => {
        interrupt.abort();
      },
    });

    expect(result.reason).toBe("interrupted");
    expect(result.step_count).toBe(1);
    // A barge-in does not close the board: "I have a question now" is not "this problem is done"
    expect(board.isClosed).toBe(false);
  });

  // There is a real window for a barge-in between sending and playout (sending
  // waits on the network). Speaking then overlaps a student who has started talking.
  it("送信の直後に割り込まれたら、その手順は喋らない", async () => {
    const interrupt = new AbortController();
    const spoken: number[] = [];
    const delivery: BoardLessonDelivery = {
      append: async (options) => {
        interrupt.abort();
        await options.onStep?.({ index: 0, speech: "ここ、見て。", board: null });
        return {
          board_id: "brd_1",
          opened: true,
          appended: 1,
          step_count: 1,
          reason: "interrupted",
          closed: false,
          rejections: [],
        };
      },
    };

    const result = await runBoardLesson({
      llm: stubLlm(lessonJson([step(0, "x = 2")])),
      system: "s",
      locale: "ja",
      delivery,
      signal: interrupt.signal,
      speak: async (delivered) => {
        spoken.push(delivered.index);
      },
    });

    expect(spoken).toEqual([]);
    // What reached the board stays (only board_open clears it)
    expect(result.steps.map((delivered) => delivered.index)).toEqual([0]);
  });
});

describe("boardCloseReasonFor", () => {
  // The time cap is the planned ending decided by the server. Making it an error
  // would show every fully used 15-minute session as "broken board".
  it("timeout は completed 扱いにする", () => {
    expect(boardCloseReasonFor("timeout")).toBe("completed");
    expect(boardCloseReasonFor("completed")).toBe("completed");
  });

  it("離脱は interrupted、エラーは error", () => {
    expect(boardCloseReasonFor("user_left")).toBe("interrupted");
    expect(boardCloseReasonFor("error")).toBe("error");
  });
});
