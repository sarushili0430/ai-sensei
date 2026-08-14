import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type BoardChannelMessage,
  type BoardStep,
  boardChannelLogSchema,
  boardChannelTopic,
  boardLessonStepsMaxCount,
  boardStepsMaxCount,
  fixturePath,
} from "@ai-sensei/contract";
import {
  buildAllowedTopics,
  checkBoardLatex,
  latexRejectionGuidanceByLocale,
} from "@ai-sensei/guardrail";
import { describe, expect, it, vi } from "vitest";
import {
  type AppendBoardOptions,
  type BoardAppendResult,
  BoardChannel,
  type BoardSink,
  type BoardStepRejection,
  checkLatexSyntax,
  createTextStreamBoardSink,
  defaultMaxRepairAttempts,
  validateHead,
  validateStep,
} from "./board.ts";

/**
 * Tests for the delivery layer. Not "does it work" but "when it breaks, is the
 * break visible".
 *
 * Four things:
 *   1. steps go out as soon as each closes (not batched)
 *   2. steps that fail validation never reach the wire
 *   3. `seq` / `index` / `step_count` work as the receiver's gap detection
 *   4. a barge-in closes the board with the partial content kept
 */

const step = (index: number, tex: string): unknown => ({
  index,
  speech: `${index}番目。ここ、見てほしいんだけど。`,
  board: { kind: "latex", tex },
});

function lessonJson(steps: readonly unknown[], title = "判別式で解の個数を見る"): string {
  return JSON.stringify({ title, topic_ids: ["M1-NIJI-HANBETSU"], steps });
}

/** Chunk boundaries must carry no meaning. */
function slice(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts;
}

async function* stream(parts: readonly string[], onBeforeYield?: (at: number) => void) {
  for (const [at, part] of parts.entries()) {
    onBeforeYield?.(at);
    // Yield to the event loop between chunks, like a real LLM stream
    await Promise.resolve();
    yield part;
  }
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

function channelWith(
  sink: BoardSink,
  locale: "ja" | "en" = "ja",
  allowedTopicIds?: readonly string[],
): BoardChannel {
  let issued = 0;
  return new BoardChannel({
    sessionId: "ses_1",
    locale,
    sink,
    ...(allowedTopicIds === undefined ? {} : { allowedTopicIds }),
    newBoardId: () => {
      issued += 1;
      return `brd_${issued}`;
    },
  });
}

/**
 * A board finished in one explanation. A test-only shortcut: in production the
 * caller calls `append()` several times before `close()` (a board lives for one
 * problem).
 *
 * It rolls "open -> append once -> close with that call's reason" into one.
 * Validation, repair and barge-in tests are unrelated to board lifetime, so they
 * go through this and observe a single call's behaviour only.
 */
async function deliverOnce(
  channel: BoardChannel,
  options: AppendBoardOptions,
): Promise<BoardAppendResult> {
  const board = channel.startBoard();
  const result = await board.append(options);
  await board.close(result.reason);
  return { ...result, closed: board.isClosed };
}

const typesOf = (sent: readonly BoardChannelMessage[]) => sent.map((message) => message.type);
const texOf = (sent: readonly BoardChannelMessage[]) =>
  sent.flatMap((message) =>
    message.type === "board_step" && message.step.board?.kind === "latex"
      ? [message.step.board.tex]
      : [],
  );

describe("板書の配送(正常系)", () => {
  it("board_open → board_step × n → board_close の順で送る", async () => {
    const sink = recordingSink();
    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(slice(lessonJson([step(0, "x^2 - 3x + 2 = 0"), step(1, "D = 9 - 8 = 1")]), 7)),
    });

    expect(typesOf(sink.sent)).toEqual(["board_open", "board_step", "board_step", "board_close"]);
    expect(result).toMatchObject({ opened: true, step_count: 2, reason: "completed" });
    // The sent sequence itself satisfies the contract (order, seq, index, step_count)
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  it("seq は種別をまたいで0始まり1ずつ", async () => {
    const sink = recordingSink();
    await deliverOnce(channelWith(sink), {
      chunks: stream(slice(lessonJson([step(0, "x = 1"), step(1, "y = 2"), step(2, "z = 3")]), 5)),
    });

    expect(sink.sent.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * `seq` is per session (contract's `envelopeFields`). Resetting it per board
   * makes the receiver read the second `board_open` as a rewind.
   */
  it("2枚目の板書でも seq は続きから振る", async () => {
    const sink = recordingSink();
    const channel = channelWith(sink);

    await deliverOnce(channel, { chunks: stream([lessonJson([step(0, "x = 1")], "1問目")]) });
    await deliverOnce(channel, { chunks: stream([lessonJson([step(0, "y = 2")], "2問目")]) });

    expect(sink.sent.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(sink.sent.map((message) => message.board_id)).size).toBe(2);
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * The heart of option A (§3-2), verified down to the delivery layer.
   * If everything were batched, the sent count would stay 0 until just before
   * the final chunk.
   */
  it("手順が閉じた端から送る(全部揃うのを待たない)", async () => {
    const sink = recordingSink();
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2"), step(2, "z = 3")]);
    const parts = slice(json, 1);
    const sentBefore: number[] = [];

    await deliverOnce(channelWith(sink), {
      chunks: stream(parts, () => sentBefore.push(sink.sent.length)),
    });

    // Before the last chunk is consumed, open + 3 steps are already out (`]`
    // closes the last step and `}` comes after). Batching would leave this at 0.
    expect(sentBefore.at(-1)).toBe(4);
    // Also check time-to-first-step: the first one lands before half the chunks.
    expect(sentBefore.findIndex((count) => count >= 2)).toBeLessThan(parts.length / 2);
    expect(typesOf(sink.sent)).toEqual([
      "board_open",
      "board_step",
      "board_step",
      "board_step",
      "board_close",
    ]);
  });

  // Audio overtaking the board makes "look here" point at an empty surface (§3-2)
  it("手順を送ってから speech を渡す", async () => {
    const sink = recordingSink();
    const order: string[] = [];
    const spoken: string[] = [];

    const trackingSink: BoardSink = {
      async send(message) {
        order.push(`send:${message.type}`);
        await sink.send(message);
      },
    };

    await deliverOnce(channelWith(trackingSink), {
      chunks: stream(slice(lessonJson([step(0, "x = 1"), step(1, "y = 2")]), 9)),
      onStep: (delivered: BoardStep) => {
        order.push("speak");
        spoken.push(delivered.speech);
      },
    });

    expect(order).toEqual([
      "send:board_open",
      "send:board_step",
      "speak",
      "send:board_step",
      "speak",
      "send:board_close",
    ]);
    expect(spoken).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Steps that failed validation                                               */
/* -------------------------------------------------------------------------- */

describe("板書の配送(描けない式)", () => {
  // Japanese inside `\text{}` renders as tofu (§3-6d) - the form the LLM most wants.
  const rejected = "\\text{よって} x = 2";

  it("弾かれた式はワイヤーに出ない(再生成しない設定)", async () => {
    const sink = recordingSink();
    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(slice(lessonJson([step(0, "x = 1"), step(1, rejected), step(2, "z = 3")]), 6)),
      maxRepairAttempts: 0,
    });

    expect(texOf(sink.sent)).toEqual(["x = 1"]);
    for (const message of sink.sent) {
      expect(JSON.stringify(message)).not.toContain("\\text");
    }
    expect(result).toMatchObject({ step_count: 1, reason: "error" });
  });

  /**
   * Never resend `board_open` after a failure. By contract the board is only
   * cleared by `board_open`, so resending blanks the screen. Here we only close,
   * keeping everything written so far.
   */
  it("落ちても板書は作り直さない(そこまでを残して閉じる)", async () => {
    const sink = recordingSink();
    await deliverOnce(channelWith(sink), {
      chunks: stream([lessonJson([step(0, "x = 1"), step(1, rejected)])]),
      maxRepairAttempts: 0,
    });

    expect(typesOf(sink.sent)).toEqual(["board_open", "board_step", "board_close"]);
    const close = sink.sent.at(-1);
    expect(close).toMatchObject({ type: "board_close", reason: "error", step_count: 1 });
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  it("再生成の指示は guardrail の文面をそのまま渡す", async () => {
    const sink = recordingSink();
    const seen: BoardStepRejection[] = [];

    await deliverOnce(channelWith(sink), {
      chunks: stream([lessonJson([step(0, rejected)])]),
      repair: async (rejection) => {
        seen.push(rejection);
        return null;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("latex");
    expect(seen[0]?.reason).toBe("text_in_math");
    expect(seen[0]?.guidance).toBe(latexRejectionGuidanceByLocale.ja.text_in_math);
    // It states where to go instead (a bare "don't" makes it flee to another form)
    expect(seen[0]?.guidance).toContain("text の板書");
    expect(seen[0]?.index).toBe(0);
  });

  it("英語のセッションには英語の指示を渡す", async () => {
    const sink = recordingSink();
    let guidance = "";

    await deliverOnce(channelWith(sink, "en"), {
      chunks: stream([lessonJson([step(0, "\\href{x}{y}")])]),
      repair: async (rejection) => {
        guidance = rejection.guidance;
        return null;
      },
    });

    expect(guidance).toBe(latexRejectionGuidanceByLocale.en.unknown_command);
    expect(guidance).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  /**
   * Option (b), exactly as adopted: repair only the failed step, keep the sent
   * ones valid, and continue.
   */
  it("直った手順は送られ、その前後の手順は影響を受けない", async () => {
    const sink = recordingSink();
    const repair = vi.fn(async (rejection: BoardStepRejection) => ({
      index: rejection.index,
      speech: "よって、こうなるね。",
      board: { kind: "text", body: "よって x = 2" },
    }));

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(slice(lessonJson([step(0, "x = 1"), step(1, rejected), step(2, "z = 3")]), 8)),
      repair,
    });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(typesOf(sink.sent)).toEqual([
      "board_open",
      "board_step",
      "board_step",
      "board_step",
      "board_close",
    ]);
    expect(result).toMatchObject({ step_count: 3, reason: "completed" });
    // Including the repair, index stays gapless from 0 in steps of 1
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
    // The failure is kept in the result (material for prompt tuning)
    expect(result.rejections.map((entry) => entry.reason)).toEqual(["text_in_math"]);
  });

  it("直しても直らなければ、上限回数で諦める", async () => {
    const sink = recordingSink();
    const repair = vi.fn(async () => step(9, rejected));

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream([lessonJson([step(0, "x = 1"), step(1, rejected)])]),
      maxRepairAttempts: 2,
      repair,
    });

    expect(repair).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ step_count: 1, reason: "error" });
    expect(result.rejections).toHaveLength(3);
    expect(texOf(sink.sent)).toEqual(["x = 1"]);
  });

  /**
   * The default is one attempt. One step of audio measures 2-5s (a 14-char median
   * in `board-lesson.json` is about 2.5s), so one regeneration costs roughly one
   * step. The second attempt is handed the same fixed wording as the first, so it
   * pays a step of silence for a retry carrying no new information.
   * Raise this only once the instructions branch into "say it differently the
   * second time".
   */
  it("既定では1回しか直させない", async () => {
    const sink = recordingSink();
    const repair = vi.fn(async () => step(0, rejected));

    await deliverOnce(channelWith(sink), {
      chunks: stream([lessonJson([step(0, rejected)])]),
      repair,
    });

    expect(defaultMaxRepairAttempts).toBe(1);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  /**
   * Output that yields no step at all must not even send `board_open`.
   * `board_open` is the signal that clears the previous board, so sending it here
   * only blanks the board the student was reading and adds no new line.
   */
  it("直させる側が落ちても、板書を白紙にしない", async () => {
    const sink = recordingSink();
    const result = await deliverOnce(channelWith(sink), {
      chunks: stream([lessonJson([step(0, rejected)])]),
      repair: async () => {
        throw new Error("LLMが落ちた");
      },
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ step_count: 0, reason: "error", opened: false });
  });

  it("契約に合わない手順も、ワイヤーに出る前に落とす", async () => {
    const sink = recordingSink();
    const seen: BoardStepRejection[] = [];

    // Math (a LaTeX command) in speech = speaking what belongs on the board
    const result = await deliverOnce(channelWith(sink), {
      chunks: stream([
        lessonJson([{ index: 0, speech: "\\frac{1}{2} を読み上げます", board: null }]),
      ]),
      repair: async (rejection) => {
        seen.push(rejection);
        return null;
      },
    });

    expect(result.step_count).toBe(0);
    expect(seen[0]?.kind).toBe("schema");
    expect(seen[0]?.guidance).toContain("speech");
    expect(sink.sent).toEqual([]);
  });

  /**
   * Stage 3 of the three-stage check (§3-6). Stage 2 (`checkBoardLatex`) only
   * looks at command names, so a broken formula built purely from allowed
   * commands - `\frac{1}{` - passes. On the device `flutter_math_fork` cannot
   * render that line and the board turns into "cannot display formula".
   */
  it("許可コマンドだけでも構文が壊れていれば、ワイヤーに出さない", async () => {
    const sink = recordingSink();
    const seen: BoardStepRejection[] = [];

    const broken = "\\frac{1}{";
    // Stage 2 lets it through (the only command is \frac, which is allow-listed)
    expect(checkBoardLatex(broken).ok).toBe(true);

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream([lessonJson([step(0, "x = 1"), step(1, broken)])]),
      repair: async (rejection) => {
        seen.push(rejection);
        return null;
      },
    });

    expect(texOf(sink.sent)).toEqual(["x = 1"]);
    expect(result).toMatchObject({ step_count: 1, reason: "error" });
    expect(seen[0]).toMatchObject({ kind: "syntax", reason: "syntax" });
    // It also says what to fix (given only a reason, the same formula comes back)
    expect(seen[0]?.guidance).toContain("{ }");
  });

  it("構文の指示も会話の言語で渡す", async () => {
    const sink = recordingSink();
    let guidance = "";

    await deliverOnce(channelWith(sink, "en"), {
      chunks: stream([lessonJson([step(0, "\\sqrt{")])]),
      repair: async (rejection) => {
        guidance = rejection.guidance;
        return null;
      },
    });

    expect(guidance).toContain("does not parse");
    expect(guidance).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

/**
 * Stage 3 on its own. It does not replace stage 2 (KaTeX passing does not mean
 * the port supports it), so confirm that formulas passing stage 2 also pass 3.
 */
describe("checkLatexSyntax", () => {
  it("括弧の閉じ忘れ・引数の不足を落とす", () => {
    for (const broken of ["\\frac{1}{", "\\sqrt{", "\\frac", "x^", "}{"]) {
      expect(checkLatexSyntax(broken).ok, broken).toBe(false);
    }
  });

  it("実測で許可した書き方は通す(②のホワイトリストと衝突しない)", () => {
    const allowed = [
      "x^2 - 3x + 2 = 0",
      "\\frac{-b \\pm \\sqrt{D}}{2a}",
      "{}_{n}\\mathrm{C}_{r}",
      "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
      "\\begin{cases} x = 1 \\\\ y = 2 \\end{cases}",
      "\\Bigl[ x^3 + x^2 \\Bigr]_0^1",
      "\\lim_{x \\to 0} \\frac{\\sin x}{x}",
      "\\int_0^1 x^2 \\, dx",
      "\\sum_{k=1}^{n} k",
      "\\binom{n}{r}",
      "\\overrightarrow{AB}",
      "\\therefore x = 2",
      "\\because D > 0",
      "d = \\frac{|{-3}|}{\\sqrt{2}}",
    ];
    for (const tex of allowed) {
      expect(checkBoardLatex(tex).ok, `② ${tex}`).toBe(true);
      expect(checkLatexSyntax(tex).ok, `③ ${tex}`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Barge-in                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Stopping once the turn is handed over (`stopAfter`).
 *
 * The prompt says "once you ask a question, end that board there", but nothing
 * enforced it. Output that broke the rule read out 12 steps in one breath,
 * question included, leaving the senpai answering their own question.
 */
describe("板書の配送(番の受け渡し)", () => {
  const asking = (index: number): unknown => ({
    index,
    speech: "a、b、c がどれか、言ってみて。",
    board: null,
  });

  it("問いかけの手順まで送ったら、残りの手順は送らない", async () => {
    const sink = recordingSink();
    const json = lessonJson([step(0, "x^2 - 3x + 2 = 0"), asking(1), step(2, "D = 1")]);

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(slice(json, 5)),
      stopAfter: (sent) => sent.speech.includes("言ってみて"),
    });

    // The question itself is delivered; only what follows it is not.
    expect(typesOf(sink.sent)).toEqual(["board_open", "board_step", "board_step", "board_close"]);
    expect(texOf(sink.sent)).toEqual(["x^2 - 3x + 2 = 0"]);
    expect(result.step_count).toBe(2);
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * Neither `interrupted` nor `error`: the student did not barge in and nothing
   * broke - the senpai handed over the turn as planned. Marking it `error` would
   * record every healthy lesson as "the board was cut off".
   */
  it("自分から降りた回は completed(途中で切れた出力と区別する)", async () => {
    const sink = recordingSink();
    const json = lessonJson([asking(0), step(1, "D = 1")]);

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(slice(json, 3)),
      stopAfter: () => true,
    });

    expect(result.reason).toBe("completed");
    expect(sink.sent.at(-1)).toMatchObject({ type: "board_close", reason: "completed" });
  });

  it("残りを読まないと決めたら、上流も離す(誰も聞かない出力に払わない)", async () => {
    const sink = recordingSink();
    const json = lessonJson([asking(0), step(1, "D = 1"), step(2, "x = 2")]);
    let released = false;

    async function* watched(): AsyncGenerator<string> {
      try {
        for (const part of slice(json, 4)) {
          await Promise.resolve();
          yield part;
        }
      } finally {
        released = true;
      }
    }

    await deliverOnce(channelWith(sink), { chunks: watched(), stopAfter: () => true });
    // `releaseIterator` is best effort and not awaited, so check after one tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(true);
  });

  it("渡していない手順では止まらない", async () => {
    const sink = recordingSink();
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2")]);

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(slice(json, 6)),
      stopAfter: (sent) => sent.speech.includes("言ってみて"),
    });

    expect(result.step_count).toBe(2);
    expect(result.reason).toBe("completed");
  });
});

describe("板書の配送(割り込み)", () => {
  it("割り込んだら interrupted で締め、step_count は送った数と一致する", async () => {
    const sink = recordingSink();
    const controller = new AbortController();
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2"), step(2, "z = 3")]);

    // Barge in once two steps have been sent
    const chunks = stream(slice(json, 1), () => {
      if (sink.sent.length === 3) controller.abort();
    });

    const result = await deliverOnce(channelWith(sink), { chunks, signal: controller.signal });

    expect(result.reason).toBe("interrupted");
    expect(result.step_count).toBe(2);
    const close = sink.sent.at(-1);
    expect(close).toMatchObject({ type: "board_close", reason: "interrupted", step_count: 2 });
    // The board keeps what was written (the point of option A, §3-2)
    expect(typesOf(sink.sent)).toEqual(["board_open", "board_step", "board_step", "board_close"]);
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * Noticing a barge-in "when the next chunk arrives" is too late - the student is
   * already talking. It must close even if the LLM goes silent.
   */
  it("チャンクを待っている最中の割り込みでも締まる", async () => {
    const sink = recordingSink();
    const controller = new AbortController();

    // Stops with one step closed (with no steps at all it would never open)
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2")]);
    const upToFirstStep = json.slice(0, json.indexOf("},{") + 1);

    async function* stalling() {
      yield upToFirstStep;
      // Nothing ever arrives from here on
      await new Promise(() => undefined);
      yield "";
    }

    const delivery = deliverOnce(channelWith(sink), {
      chunks: stalling(),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const result = await delivery;
    expect(result.reason).toBe("interrupted");
    expect(result.step_count).toBe(1);
    expect(sink.sent.at(-1)).toMatchObject({ type: "board_close", reason: "interrupted" });
  });

  it("開く前に割り込まれたら、何も送らない", async () => {
    const sink = recordingSink();
    const controller = new AbortController();
    controller.abort();

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream([lessonJson([step(0, "x = 1")])]),
      signal: controller.signal,
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, step_count: 0, reason: "interrupted" });
  });
});

/* -------------------------------------------------------------------------- */
/* Board lifetime = one problem (not one LLM call)                            */
/* -------------------------------------------------------------------------- */

/**
 * This is the seam under test.
 *
 * Teaching is not one round trip (diagnose -> teach -> have them teach back).
 * Reopening the board per LLM call would, by contract, clear it on every
 * `board_open`, wiping the formula the student was reading once per exchange.
 * §3-2's "never erase earlier lines; only a new problem clears them" would break
 * every turn.
 */
describe("板書の寿命", () => {
  /** LLM output of n steps. `index` starts at 0 *within that output* (the LLM has no running count). */
  function lessonOf(count: number, offset = 0): string {
    return lessonJson(
      Array.from({ length: count }, (_, at) => step(at, `x = ${offset + at}`)),
      "判別式で解の個数を見る",
    );
  }

  it("何回説明しても board_open は1回だけ(板書は消えない)", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await board.append({ chunks: stream([lessonOf(2)]) }); // diagnose
    await board.append({ chunks: stream([lessonOf(3, 10)]) }); // teach
    await board.append({ chunks: stream([lessonOf(1, 20)]) }); // hand over to teach-back
    await board.close("completed");

    expect(typesOf(sink.sent).filter((type) => type === "board_open")).toHaveLength(1);
    expect(new Set(sink.sent.map((message) => message.board_id)).size).toBe(1);
    expect(typesOf(sink.sent)).toEqual([
      "board_open",
      ...Array.from({ length: 6 }, () => "board_step"),
      "board_close",
    ]);
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * The LLM does not know which call this is, so it counts from 0 every time.
   * The delivery layer assigns the running number (letting the LLM do it puts
   * hallucinated numbers on the wire).
   */
  it("LLMが毎回0始まりで返しても、ワイヤーの index は板書を通して連続する", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    const first = await board.append({ chunks: stream([lessonOf(3)]) });
    const second = await board.append({ chunks: stream([lessonOf(2, 10)]) });
    const third = await board.append({ chunks: stream([lessonOf(2, 20)]) });

    // LLM output is 0,1,2 / 0,1 / 0,1
    expect(JSON.parse(lessonOf(2, 10)).steps.map((s: { index: number }) => s.index)).toEqual([
      0, 1,
    ]);
    // The wire is 0..6
    expect(
      sink.sent.flatMap((message) => (message.type === "board_step" ? [message.step.index] : [])),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);

    expect(first).toMatchObject({ appended: 3, step_count: 3 });
    expect(second).toMatchObject({ appended: 2, step_count: 5 });
    expect(third).toMatchObject({ appended: 2, step_count: 7 });
    expect(board.stepCount).toBe(7);
  });

  it("board_close.step_count は板書全体で送った数", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await board.append({ chunks: stream([lessonOf(3)]) });
    await board.append({ chunks: stream([lessonOf(4, 10)]) });
    await board.close("completed");

    expect(sink.sent.at(-1)).toMatchObject({
      type: "board_close",
      step_count: 7,
      reason: "completed",
    });
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * A barge-in means "I have a question now", not "this problem is done".
   * Closing here would wipe the board when the same problem resumes after the
   * question is answered.
   */
  it("割り込みでは板書を閉じない(続きは同じ板書に積める)", async () => {
    const sink = recordingSink();
    const controller = new AbortController();
    const board = channelWith(sink).startBoard();

    const json = lessonOf(3);
    const interrupted = await board.append({
      chunks: stream(slice(json, 1), () => {
        if (sink.sent.length === 2) controller.abort();
      }),
      signal: controller.signal,
    });

    expect(interrupted).toMatchObject({ reason: "interrupted", closed: false });
    expect(board.isOpen).toBe(true);
    expect(typesOf(sink.sent)).not.toContain("board_close");

    // After answering the barge-in, append to the same board
    const resumed = await board.append({ chunks: stream([lessonOf(2, 10)]) });
    expect(resumed).toMatchObject({ reason: "completed", appended: 2 });
    expect(typesOf(sink.sent).filter((type) => type === "board_open")).toHaveLength(1);

    await board.close("completed");
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  // Closing after one failed explanation would mean reopening on the next one.
  it("検証に落ちても板書を閉じない(次の説明は同じ板書に続く)", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    const failed = await board.append({
      chunks: stream([lessonJson([step(0, "x = 1"), step(1, "\\text{よって} x = 2")])]),
      maxRepairAttempts: 0,
    });

    expect(failed).toMatchObject({ reason: "error", appended: 1, closed: false });
    expect(board.isOpen).toBe(true);

    const next = await board.append({ chunks: stream([lessonOf(2, 10)]) });
    expect(next).toMatchObject({ reason: "completed", step_count: 3 });
    expect(typesOf(sink.sent).filter((type) => type === "board_open")).toHaveLength(1);
  });

  /**
   * Only a board that hit its cap is closed. Leaving open a board that cannot
   * take one more step makes the caller keep calling the LLM into a black hole.
   */
  it("板書1枚の上限に達したら閉じ、以降は1件も送らない", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    // One output is capped at 12 steps; append until 40. Whether more can be
    // appended is read from `isClosed` (`isOpen` turns true after board_open is sent).
    let guard = 0;
    while (!board.isClosed && guard < 10) {
      await board.append({ chunks: stream([lessonOf(boardLessonStepsMaxCount, guard * 100)]) });
      guard += 1;
    }

    expect(board.stepCount).toBe(boardStepsMaxCount);
    expect(board.isClosed).toBe(true);
    expect(sink.sent.at(-1)).toMatchObject({
      type: "board_close",
      step_count: boardStepsMaxCount,
      reason: "error",
    });
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);

    // Appending to a closed board puts nothing on the wire
    const sentAfterClose = sink.sent.length;
    const refused = await board.append({ chunks: stream([lessonOf(2)]) });
    expect(refused).toMatchObject({ appended: 0, reason: "error", closed: true });
    expect(sink.sent).toHaveLength(sentAfterClose);
  });

  /**
   * A close that could not be sent must not count as closed.
   * To the receiver the board is still open, so the next problem's `board_open`
   * is rejected with "the previous board was not board_closed" - one send failure
   * would suppress every board for the rest of the session.
   */
  it("board_close の送信に失敗したら、締め直せる状態のまま残す", async () => {
    const sent: BoardChannelMessage[] = [];
    let failClose = true;
    const flaky: BoardSink = {
      async send(message) {
        if (failClose && message.type === "board_close") {
          failClose = false;
          throw new Error("ストリームが開けない");
        }
        sent.push(message);
      },
    };

    const board = new BoardChannel({
      sessionId: "ses_1",
      locale: "ja",
      sink: flaky,
      newBoardId: () => "brd_1",
    }).startBoard();

    await board.append({ chunks: stream([lessonJson([step(0, "x = 1")])]) });
    await board.close("completed");

    // A failed close does not count as closed
    expect(board.isClosed).toBe(false);
    expect(typesOf(sent)).toEqual(["board_open", "board_step"]);

    // It can be closed again; seq was not consumed, so no number is skipped.
    await board.close("completed");
    expect(board.isClosed).toBe(true);
    expect(typesOf(sent)).toEqual(["board_open", "board_step", "board_close"]);
    expect(sent.map((message) => message.seq)).toEqual([0, 1, 2]);
    expect(boardChannelLogSchema.safeParse({ messages: sent }).success).toBe(true);
  });

  /**
   * `boardLessonSchema` requires at least one `steps` entry. Returning `completed`
   * for output that parsed but was empty makes the caller think the board
   * appeared and advance the audio alone.
   */
  it("手順が空の出力は成功にしない(板書も開かない)", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    const result = await board.append({
      chunks: stream([
        JSON.stringify({ title: "見出し", topic_ids: ["M1-NIJI-HANBETSU"], steps: [] }),
      ]),
    });

    expect(result).toMatchObject({ reason: "error", appended: 0, opened: false });
    expect(sink.sent).toEqual([]);
  });

  // Even on an already-open board, empty output is not a success (keeps audio from running ahead)
  it("2回目の出力が空でも成功にしない", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await board.append({ chunks: stream([lessonJson([step(0, "x = 1")])]) });
    const empty = await board.append({
      chunks: stream([
        JSON.stringify({ title: "見出し", topic_ids: ["M1-NIJI-HANBETSU"], steps: [] }),
      ]),
    });

    expect(empty).toMatchObject({ reason: "error", appended: 0, step_count: 1 });
    expect(typesOf(sink.sent)).toEqual(["board_open", "board_step"]);
  });

  // A double close reads to the receiver as "a message for an unopened board" (contract violation)
  it("close を2回呼んでも board_close は1回だけ", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await board.append({ chunks: stream([lessonOf(1)]) });
    await board.close("completed");
    await board.close("error");

    expect(typesOf(sink.sent).filter((type) => type === "board_close")).toHaveLength(1);
    expect(sink.sent.at(-1)).toMatchObject({ reason: "completed" });
  });

  // The heading says which problem this is, so it is not resent unless the problem changes
  it("2回目以降の出力の見出しは捨てる(board_open を出し直さない)", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await board.append({ chunks: stream([lessonJson([step(0, "x = 1")], "1回目の見出し")]) });
    await board.append({ chunks: stream([lessonJson([step(0, "y = 2")], "2回目の見出し")]) });
    await board.close("completed");

    const opens = sink.sent.filter((message) => message.type === "board_open");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ title: "1回目の見出し" });
    expect(JSON.stringify(sink.sent)).not.toContain("2回目の見出し");
  });

  it("開かないまま close しても、何も送らない", async () => {
    const sink = recordingSink();
    const board = channelWith(sink).startBoard();

    await board.append({ chunks: stream(["板書は作れませんでした。"]) });
    await board.close("error");

    expect(sink.sent).toEqual([]);
    expect(channelWith(sink).nextSeq).toBe(0);
  });

  /**
   * Moving to another problem starts a new board. Only here does the screen
   * change (§3-2: "only a new problem clears it").
   */
  it("別の問題では新しい板書になり、seq はセッションを通して連続する", async () => {
    const sink = recordingSink();
    const channel = channelWith(sink);

    const first = channel.startBoard();
    await first.append({ chunks: stream([lessonJson([step(0, "x = 1")], "1問目")]) });
    await first.append({ chunks: stream([lessonJson([step(0, "y = 2")], "1問目のつづき")]) });
    await first.close("completed");

    const second = channel.startBoard();
    await second.append({ chunks: stream([lessonJson([step(0, "z = 3")], "2問目")]) });
    await second.close("completed");

    expect(sink.sent.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(sink.sent.map((message) => message.board_id)).size).toBe(2);
    expect(first.id).not.toBe(second.id);
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Breaking visibly when it breaks                                            */
/* -------------------------------------------------------------------------- */

describe("板書の配送(壊れ方)", () => {
  it("途中で切れたストリームは completed にしない", async () => {
    const sink = recordingSink();
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2")]);

    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(slice(json.slice(0, json.length - 20), 13)),
    });

    expect(result).toMatchObject({ step_count: 1, reason: "error" });
    expect(sink.sent.at(-1)).toMatchObject({ reason: "error", step_count: 1 });
  });

  it("ヘッダが来ないまま終わったら、1件も送らない", async () => {
    const sink = recordingSink();
    const result = await deliverOnce(channelWith(sink), {
      chunks: stream([JSON.stringify({ steps: [step(0, "x = 1")] })]),
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, step_count: 0, reason: "error" });
  });

  // Better to open no board at all than a broken one
  it("見出しが契約に合わなければ、板書を開かない", async () => {
    const sink = recordingSink();
    const result = await deliverOnce(channelWith(sink), {
      chunks: stream([JSON.stringify({ title: "", topic_ids: [], steps: [step(0, "x = 1")] })]),
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, reason: "error" });
  });

  /**
   * Close off the loophole of pouring a whole worked answer through as "one line
   * at a time, but 40 lines" (contract's `boardLessonStepsMaxCount`) before
   * sending. Not one step past the cap reaches the wire.
   *
   * The board is not closed here: one output was merely too long, and the problem
   * continues.
   */
  it("1回の出力が12手順を超えたら、そこで打ち切る(板書は閉じない)", async () => {
    const sink = recordingSink();
    const many = Array.from({ length: boardLessonStepsMaxCount + 3 }, (_, at) =>
      step(at, `x = ${at}`),
    );

    const board = channelWith(sink).startBoard();
    const result = await board.append({ chunks: stream(slice(lessonJson(many), 20)) });

    expect(result).toMatchObject({
      appended: boardLessonStepsMaxCount,
      reason: "error",
      closed: false,
    });
    expect(board.isOpen).toBe(true);
    expect(sink.sent.filter((message) => message.type === "board_step")).toHaveLength(
      boardLessonStepsMaxCount,
    );
    expect(typesOf(sink.sent)).not.toContain("board_close");
  });

  /**
   * `index` is a delivery fact - which board line to append to. Passing the LLM's
   * miscount through makes the receiver judge a correctly delivered board as
   * "missing entries".
   *
   * The warning is compared against `position` (the position within that output).
   * Comparing it to the wire's running number would mark every step of the second
   * and later explanations as "off", burying real miscounts.
   */
  it("LLMが index を間違えても、送信位置で上書きする", async () => {
    const sink = recordingSink();
    const warn = vi.fn();
    const channel = new BoardChannel({
      sessionId: "ses_1",
      locale: "ja",
      sink,
      newBoardId: () => "brd_1",
      log: { info: vi.fn(), warn },
    });

    await deliverOnce(channel, {
      chunks: stream([lessonJson([step(0, "x = 1"), step(7, "y = 2"), step(1, "z = 3")])]),
    });

    expect(
      sink.sent.flatMap((message) => (message.type === "board_step" ? [message.step.index] : [])),
    ).toEqual([0, 1, 2]);
    expect(warn).toHaveBeenCalledWith("board_step_index_overridden", {
      declared: 7,
      position: 1,
      index: 1,
    });
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  it("JSONではないものが流れてきたら、開かずに終わる", async () => {
    const sink = recordingSink();
    const result = await deliverOnce(channelWith(sink), {
      chunks: stream(["すみません、板書は作れませんでした。"]),
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, reason: "error" });
  });

  /**
   * Consuming `seq` for an envelope that was not sent looks like "a board with one
   * entry missing" to the receiver and drags the next step down with it.
   */
  it("送信に失敗した封筒は seq を消費しない", async () => {
    const sent: BoardChannelMessage[] = [];
    let failNext = false;
    const flaky: BoardSink = {
      async send(message) {
        if (failNext && message.type === "board_step") {
          failNext = false;
          throw new Error("ストリームが開けない");
        }
        sent.push(message);
      },
    };

    const channel = new BoardChannel({
      sessionId: "ses_1",
      locale: "ja",
      sink: flaky,
      newBoardId: () => "brd_1",
    });

    failNext = true;
    const result = await deliverOnce(channel, { chunks: stream([lessonJson([step(0, "x = 1")])]) });

    expect(result).toMatchObject({ step_count: 0, reason: "error" });
    expect(sent.map((message) => message.seq)).toEqual([0, 1]);
    expect(typesOf(sent)).toEqual(["board_open", "board_close"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Parts                                                                      */
/* -------------------------------------------------------------------------- */

describe("validateStep", () => {
  it("index は申告ではなく送信位置で決まる", () => {
    const verdict = validateStep({ index: 9, speech: "ここ、見て。", board: null }, 2, "ja");
    expect(verdict.ok && verdict.step.index).toBe(2);
  });

  it("latex 以外の要素は LaTeX照合にかけない", () => {
    const verdict = validateStep(
      { index: 0, speech: "まとめるね。", board: { kind: "text", body: "よって x = 2" } },
      0,
      "ja",
    );
    expect(verdict.ok).toBe(true);
  });

  it("環境の外の改行は落とす(1手順=1行)", () => {
    const verdict = validateStep(
      { index: 0, speech: "ここ。", board: { kind: "latex", tex: "x = 1 \\\\ y = 2" } },
      0,
      "ja",
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.rejection.reason).toBe("row_separator_outside_environment");
  });

  it("落ちた理由には、そのまま使える指示が付く", () => {
    const verdict = validateStep(
      {
        index: 0,
        speech: "ここ。",
        board: { kind: "latex", tex: "\\begin{align} x = 1 \\end{align}" },
      },
      0,
      "ja",
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rejection.guidance.length).toBeGreaterThan(0);
      expect(verdict.rejection.raw).toMatchObject({ speech: "ここ。" });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Contract fixtures, straight through the pipe                               */
/* -------------------------------------------------------------------------- */

/**
 * The `board-lesson` fixtures are the contract side's sample of "this is what the
 * LLM emits". Pin down that they pass through the delivery layer unchanged.
 *
 * This fails when a fixture gains a formula `packages/guardrail` cannot render
 * (= the contract's sample and what can actually be sent have drifted apart).
 * The fixture parse tests on the contract side can never surface that drift.
 */
describe("契約のfixture", () => {
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
  const load = (name: string): string => readFileSync(resolve(repoRoot, fixturePath(name)), "utf8");

  for (const name of ["board-lesson", "board-lesson.en"]) {
    it(`${name} は1手順も落とさずにワイヤーへ出る`, async () => {
      const json = load(name);
      const lesson = JSON.parse(json) as { title: string; steps: unknown[] };
      const sink = recordingSink();

      const result = await deliverOnce(channelWith(sink, name.endsWith(".en") ? "en" : "ja"), {
        chunks: stream(slice(json, 3)),
      });

      expect(result).toMatchObject({
        opened: true,
        step_count: lesson.steps.length,
        reason: "completed",
        rejections: [],
      });
      expect(sink.sent[0]).toMatchObject({ type: "board_open", title: lesson.title });
      expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
    });
  }
});

describe("createTextStreamBoardSink", () => {
  // Never raw publishData (it defaults to LOSSY, and forgetting silently drops board lines, §3-5)
  it("封筒1つを1ストリームで、topic `board` に送る", async () => {
    const sendText = vi.fn(async () => ({}));
    const sink = createTextStreamBoardSink({ sendText });

    await sink.send({
      v: 1,
      session_id: "ses_1",
      board_id: "brd_1",
      seq: 0,
      type: "board_close",
      step_count: 0,
      reason: "completed",
    });

    expect(sendText).toHaveBeenCalledTimes(1);
    const [payload, options] = sendText.mock.calls[0] as unknown as [string, { topic?: string }];
    expect(options.topic).toBe(boardChannelTopic);
    expect(JSON.parse(payload)).toMatchObject({ type: "board_close", seq: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* Scope validity of what may be taught (plan §8)                             */
/* -------------------------------------------------------------------------- */

/**
 * Checking the board's `topic_id`. The karte side has `filterHoleTopicIds` while
 * the board had only one wing. The contract's `topicIdSchema` checks format
 * only, so a well-formed but unrelated unit passes straight through.
 */
describe("validateHead", () => {
  const allowed = buildAllowedTopics(["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"], {
    prerequisiteDepth: 0,
  });

  it("許可リストの中なら通す", () => {
    expect(
      validateHead({ title: "判別式", topic_ids: ["M1-NIJI-HANBETSU"] }, allowed, "ja"),
    ).toEqual({ ok: true });
  });

  // The format is valid, so `topicIdSchema` does not stop it
  it("形だけ正しい別単元を弾く", () => {
    const verdict = validateHead(
      { title: "ベクトルの内積", topic_ids: ["M2-ZUKEI-ENCHOKU", "MB-VECTOR-NAISEKI"] },
      allowed,
      "ja",
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.reason).toBe("topic_not_allowed");
    // Report only the out-of-scope id (curriculum is a closed vocabulary, safe to log)
    expect(verdict.rejection.detail).toBe("MB-VECTOR-NAISEKI");
    expect(verdict.rejection.guidance).toContain("許可リスト");
  });

  it("再生成の指示は会話の言語で書く", () => {
    const verdict = validateHead({ topic_ids: ["MB-VECTOR-NAISEKI"] }, allowed, "en");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.guidance).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  // Shape checking belongs to the envelope schema; do not judge twice and disagree
  it("形が違うものはここでは弾かない", () => {
    expect(validateHead({ topic_ids: "not an array" }, allowed, "ja")).toEqual({ ok: true });
    expect(validateHead(null, allowed, "ja")).toEqual({ ok: true });
  });
});

describe("板書の範囲の照合(配送を通して)", () => {
  const allowedIds = ["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"];

  function lessonWithTopics(topicIds: readonly string[]): string {
    return JSON.stringify({
      title: "判別式で解の個数を見る",
      topic_ids: topicIds,
      steps: [step(0, "x^2 - 3x + 2 = 0")],
    });
  }

  it("範囲内ならそのまま開く", async () => {
    const sink = recordingSink();
    const result = await deliverOnce(channelWith(sink, "ja", allowedIds), {
      chunks: stream(slice(lessonWithTopics(["M1-NIJI-HANBETSU"]), 9)),
    });

    expect(result.opened).toBe(true);
    expect(sink.sent[0]).toMatchObject({ type: "board_open", topic_ids: ["M1-NIJI-HANBETSU"] });
  });

  // Checked before any step is sent, so a rejection leaves the screen untouched
  it("範囲外なら作り直させ、直ったものを開く", async () => {
    const sink = recordingSink();
    const repairHead = vi.fn(async () => ({
      title: "判別式で解の個数を見る",
      topic_ids: ["M1-NIJI-HANBETSU"],
    }));

    await deliverOnce(channelWith(sink, "ja", allowedIds), {
      chunks: stream(slice(lessonWithTopics(["MB-VECTOR-NAISEKI"]), 9)),
      repairHead,
    });

    expect(repairHead).toHaveBeenCalledTimes(1);
    expect(sink.sent[0]).toMatchObject({ type: "board_open", topic_ids: ["M1-NIJI-HANBETSU"] });
  });

  /**
   * A failed repair must not kill the board. Stopping it costs the student the
   * whole 15-minute lesson, and a slightly off-scope board beats no board.
   */
  it("作り直しが失敗しても、授業は続ける", async () => {
    const sink = recordingSink();
    const warnings: string[] = [];

    const channel = new BoardChannel({
      sessionId: "ses_1",
      locale: "ja",
      sink,
      allowedTopicIds: allowedIds,
      newBoardId: () => "brd_1",
      log: { info: () => undefined, warn: (event) => warnings.push(event) },
    });

    const board = channel.startBoard();
    const result = await board.append({
      chunks: stream(slice(lessonWithTopics(["MB-VECTOR-NAISEKI"]), 9)),
      repairHead: async () => null,
    });

    expect(result.opened).toBe(true);
    expect(result.step_count).toBe(1);
    // Logged as a degradation (material for fixing the prompt if it recurs)
    expect(warnings).toContain("board_topics_rejected");
  });

  it("許可集合を渡さなければ照合しない(テストと、範囲が取れない経路)", async () => {
    const sink = recordingSink();
    const repairHead = vi.fn(async () => null);

    await deliverOnce(channelWith(sink), {
      chunks: stream(slice(lessonWithTopics(["MB-VECTOR-NAISEKI"]), 9)),
      repairHead,
    });

    expect(repairHead).not.toHaveBeenCalled();
  });
});

describe("figure(作図)", () => {
  const figureStep = (items: unknown) => ({
    index: 0,
    speech: "この図を見て",
    board: { kind: "figure", items },
  });

  it("解けた図には svg と alt が入る(先輩は svg を書かない)", () => {
    const verdict = validateStep(
      figureStep([
        { pt: "A", at: [0, 4] },
        { pt: "B", at: [-3, -2] },
        { pt: "C", at: [3, -2] },
        { poly: ["A", "B", "C"] },
      ]),
      0,
      "ja",
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const board = verdict.step.board;
    expect(board?.kind).toBe("figure");
    if (board?.kind !== "figure") return;
    expect(board.svg?.startsWith("<svg")).toBe(true);
    expect(board.alt).toContain("多角形");
  });

  it("解けない図は落とし、理由をそのまま直しの指示にする", () => {
    const verdict = validateStep(figureStep([{ circle: "K", center: "O", r: 3 }]), 0, "ja");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.kind).toBe("figure");
    expect(verdict.rejection.detail).toContain("未定義の点");
    expect(verdict.rejection.guidance).toContain("未定義の点");
  });

  it("長さのラベルが実際と食い違う図は通さない", () => {
    const verdict = validateStep(
      figureStep([
        { pt: "A", at: [0, 0] },
        { pt: "B", at: [10, 0] },
        { seg: ["A", "B"], label: "6" },
      ]),
      0,
      "ja",
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.detail).toContain("実際の長さ");
  });

  it("先輩が svg を書いてきても、契約が受け取らない", () => {
    const verdict = validateStep(
      {
        ...figureStep([{ pt: "A", at: [0, 0] }]),
        board: {
          kind: "figure",
          items: [{ pt: "A", at: [0, 0] }],
          svg: '<svg onload="alert(1)"/>',
        },
      },
      0,
      "ja",
    );
    // svg is optional so the shape passes, but it is overwritten by the SVG we solved
    if (!verdict.ok) return;
    const board = verdict.step.board;
    if (board?.kind !== "figure") return;
    expect(board.svg).not.toContain("onload");
  });

  it("知らないキーは契約の段で落ちる", () => {
    const verdict = validateStep(figureStep([{ pt: "A", at: [0, 0], colour: "red" }]), 0, "ja");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.kind).toBe("schema");
  });
});
