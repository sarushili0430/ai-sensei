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
 * 授業フェーズのテスト。見たいのは3つ:
 *
 *   1. SSEが**チャンクの切れ目に関係なく**テキストのデルタになること
 *   2. **板書を送ってから喋る**順序が、手順ごとに崩れないこと(§3-2)
 *   3. 割り込み・検証落ち・空の出力で、**板書が閉じないこと**(寿命は1つの問題)
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

/** バイト列で切る。**マルチバイトの途中で切れる**のが実際のネットワークの姿。 */
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

  // チャンクは行の途中でも、日本語の1文字の途中でも切れる。
  // ここが壊れると、板書のJSONに文字化けが混ざって走査ごと落ちる。
  it("マルチバイトの途中で切れても壊れない", async () => {
    const sse = deltaEvent("判別式で解の個数を見る") + deltaEvent("、を板書に出す");

    expect(await collect(readTextDeltas(bodyOf(byteChunks(sse, 3))))).toBe(
      "判別式で解の個数を見る、を板書に出す",
    );
  });

  // 待っても直らないので、黙って読み飛ばさずに投げる(呼び出し側が error で締める)。
  it("APIのエラーイベントは理由を付けて投げる", async () => {
    const sse = `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    })}\n\n`;

    await expect(collect(readTextDeltas(bodyOf(byteChunks(sse, 4096))))).rejects.toThrow(
      /Overloaded/,
    );
  });

  // 読み飛ばすと**手順が1つ減ったまま板書が完成**してしまう
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
    // 既定でadaptive thinkingが入るモデルだと、思考時間がそのまま冒頭の無音になる
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.model).toBe("claude-sonnet-5");
  });

  // イテレータを離すだけでは接続が残り、聞かれない板書のトークンを払い続ける
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
/* 授業の配送                                                                  */
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

/** 出力を1回ぶん返すだけのLLM。呼ばれた `user` を記録する。 */
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
        // 実際のストリームと同じく、チャンクの間にイベントループを挟む
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
  // §3-2 の順序。逆にすると「ここ、見て」が空の盤面を指す。
  it("板書を送ってから喋る、を手順ごとに繰り返す", async () => {
    // 送信と読み上げを**同じ列**に積んで、交互になっていることを見る
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
   * **ターン制はプロンプトの願いではなく、ここで守る。**
   *
   * 板書プロンプトは「質問を出したら、その板書はそこで終える。`steps` を続けない」と
   * 書いているが、生成が1回ぶれると問いかけごと12手順を一息で読み上げる。
   * 生徒から見ると、先輩が自分の質問に自分で答えながら喋り続ける
   * (2026-08-12 の「ターン制を守り切れていない」報告)。
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

    // 問いかけまでは届ける。その先は生徒の答えを聞いてから。
    expect(spoken).toEqual([0, 1]);
    expect(result.step_count).toBe(2);
    // 壊れたのではなく、予定どおり番を渡しただけ。
    expect(result.reason).toBe("completed");
  });

  it("類題を送る前に止めると、板書にも音声にも類題を出さない", async () => {
    const spoken: number[] = [];
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    const result = await runBoardLesson({
      llm: stubLlm(
        lessonJson([
          step(0, "D = b^2 - 4ac"),
          {
            index: 1,
            speech: "じゃあ、数だけ替えたこれはどうなる?",
            board: { kind: "latex", tex: "x^2 - 5x + 6 = 0" },
            awaits_solving: true,
          },
          step(2, "x = 99"),
        ]),
      ),
      system: "s",
      locale: "ja",
      delivery: board,
      stopBefore: (delivered) => delivered.awaits_solving === true,
      speak: async (delivered) => {
        spoken.push(delivered.index);
      },
    });

    expect(spoken).toEqual([0]);
    expect(result.steps.map((delivered) => delivered.index)).toEqual([0]);
    expect(result.step_count).toBe(1);
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

  // 板書の寿命は1つの問題。教え返しの間も残っていないと、説明する対象が消える。
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

  // 検証に落ちた手順を作り直させる配線。ここが繋がっていないと、
  // 描けない式が1つ来ただけでその回の説明が丸ごと止まる。
  it("落ちた手順は理由を添えて作り直させ、直ったものを送る", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();
    // 数式に日本語を入れると、端末では黒い棒に化ける(計画書 §3-6d)
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
    // 作り直しの依頼には、落ちた理由(guardrailの指示文)がそのまま入る
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
    // 1手順も確定していないので board_open すら送らない(前の板書を白紙にしない)
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
    // 割り込みでも板書は閉じない。「いま質問がある」であって「この問題は終わり」ではない
    expect(board.isClosed).toBe(false);
  });

  // 送信と読み上げの間に割り込みが入る窓は実際にある(送信はネットワーク待ち)。
  // そこで喋ると、生徒が話し始めた上に音声が重なる。
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
    // 板書に出た事実は残す(消えるのは board_open のときだけ)
    expect(result.steps.map((delivered) => delivered.index)).toEqual([0]);
  });
});

describe("boardCloseReasonFor", () => {
  // 上限時間はサーバが決めた予定どおりの終わり方。エラーにすると、
  // 15分使い切ったセッションが全部「壊れた板書」に見える。
  it("timeout は completed 扱いにする", () => {
    expect(boardCloseReasonFor("timeout")).toBe("completed");
    expect(boardCloseReasonFor("completed")).toBe("completed");
  });

  it("離脱は interrupted、エラーは error", () => {
    expect(boardCloseReasonFor("user_left")).toBe("interrupted");
    expect(boardCloseReasonFor("error")).toBe("error");
  });
});
