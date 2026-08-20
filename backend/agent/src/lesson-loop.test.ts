import type { BoardChannelMessage } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { BoardChannel, type BoardSink } from "./board.ts";
import { StudentUtterances, runLessonLoop } from "./lesson-loop.ts";
import type { LessonLlm } from "./lesson.ts";
import { lessonSteps, studentSilenceMarker, teachBackFallback, teachBackPrompt } from "./senpai.ts";

/**
 * 授業の**往復**のテスト。見たいのは4つ:
 *
 *   1. 問いかけで止まり、答えを受けて**同じ板書**に続きが積まれること
 *      (`board_open` は1回だけ・`index` は通しで増える)
 *   2. 「自分の言葉で説明してみて」で往復が終わること(途中の質問では終わらない)
 *   3. 説明の途中の発話がパスを中止し、**会話へ落とさず**続きのパスで応えること
 *   4. 安全弁(回数・セッション終了)で降りるとき、積み残しの発話を
 *      取り出さないこと(記録も返事も会話モードが引き取る)
 *   5. 答え待ちの問いが板書に残ったかを、本文なしの種別ログで観測できること
 */

const step = (index: number, speech: string, tex?: string): unknown => ({
  index,
  speech,
  board: tex === undefined ? null : { kind: "latex", tex },
});

/** `awaits_student` を明示した手順。番の受け渡しの申告(#122)のテスト用。 */
const stepAwaiting = (index: number, speech: string, awaits: boolean, tex?: string): unknown => ({
  index,
  speech,
  board: tex === undefined ? null : { kind: "latex", tex },
  awaits_student: awaits,
});

/** 問いを画面に残す、`text` の短い Q 行。Issue #153 の推奨形。 */
const stepAwaitingWithQuestion = (index: number, speech: string, question: string): unknown => ({
  index,
  speech,
  board: { kind: "text", body: `Q: ${question}` },
  awaits_student: true,
});

/** 類題を出して、解き終わりの本人申告まで待つ手順。 */
const stepSolving = (index: number, speech: string, tex: string): unknown => ({
  index,
  speech,
  board: { kind: "latex", tex },
  awaits_solving: true,
});

function lessonJson(steps: readonly unknown[]): string {
  return JSON.stringify({
    title: "最小公倍数で分母をそろえる",
    topic_ids: ["M1-NIJI-HANBETSU"],
    steps,
  });
}

/** 出力を呼び出し順に返すLLM。呼ばれた system と `user`(指示)を記録する。 */
function stubLlm(
  ...outputs: readonly string[]
): LessonLlm & { asked: string[]; systems: string[]; tails: (string | undefined)[] } {
  const asked: string[] = [];
  const systems: string[] = [];
  const tails: (string | undefined)[] = [];
  let call = 0;
  return {
    asked,
    systems,
    tails,
    stream({ system, systemTail, user }) {
      systems.push(system);
      tails.push(systemTail);
      asked.push(user);
      const output = outputs[Math.min(call, outputs.length - 1)] ?? "";
      call += 1;
      return (async function* () {
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

function boardWith(sink: BoardSink) {
  return new BoardChannel({
    sessionId: "ses_1",
    locale: "ja",
    sink,
    newBoardId: () => "brd_1",
  }).startBoard();
}

const never = new AbortController();

type LoopOverrides = Partial<Parameters<typeof runLessonLoop>[0]>;

function loopWith(
  llm: LessonLlm,
  board: ReturnType<typeof boardWith>,
  overrides: LoopOverrides = {},
) {
  return runLessonLoop({
    llm,
    system: () => "先輩の板書プロンプト",
    locale: "ja",
    delivery: board,
    speak: async () => undefined,
    signal: never.signal,
    utterances: new StudentUtterances(),
    record: () => undefined,
    practiceProblemEnabled: true,
    remainingSeconds: () => 600,
    ...overrides,
  });
}

describe("StudentUtterances", () => {
  it("待っている取り出しへ、次の発話を渡す", async () => {
    const utterances = new StudentUtterances();
    const waiting = utterances.take(1000);
    utterances.push("12だと思う");
    await expect(waiting).resolves.toBe("12だと思う");
    expect(utterances.pending).toBe(false);
  });

  it("空白だけの発話は積まず、合図も出さない", () => {
    const utterances = new StudentUtterances();
    let pushed = 0;
    utterances.onPush(() => {
      pushed += 1;
    });
    utterances.push("   ");
    expect(utterances.pending).toBe(false);
    expect(pushed).toBe(0);
  });

  it("時間切れは null(積まれた発話はあとから取り出せる)", async () => {
    const utterances = new StudentUtterances();
    await expect(utterances.take(1)).resolves.toBeNull();
    utterances.push("あとから");
    expect(utterances.tryTake()).toBe("あとから");
  });

  it("中止の合図でも null で返す", async () => {
    const utterances = new StudentUtterances();
    const abort = new AbortController();
    const waiting = utterances.take(5000, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it("発話が積まれた瞬間に合図が鳴り、解除できる", () => {
    const utterances = new StudentUtterances();
    let heard = 0;
    const detach = utterances.onPush(() => {
      heard += 1;
    });
    utterances.push("えっと");
    detach();
    utterances.push("もう聞こえない");
    expect(heard).toBe(1);
  });

  it("新しい問題へ移ると、類題の解答待ちと積み残しを消す", async () => {
    const utterances = new StudentUtterances();
    utterances.push("前の問題はできた");
    expect(utterances.pending).toBe(true);
    utterances.clear();
    expect(utterances.pending).toBe(false);

    const waiting = utterances.takeUntil(new AbortController().signal);
    utterances.clear();
    await expect(waiting).resolves.toBeNull();
  });
});

describe("runLessonLoop", () => {
  it("類題を出して15秒判定を使わず待ち、「できた」なら理由の教え返しへ渡す", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "流れはこの3つ。", "D = b^2 - 4ac"),
        stepSolving(1, "じゃあ、この類題はどうなる? 解けたら教えて。", "x^2 - 5x + 6 = 0"),
      ]),
      lessonJson([
        step(0, "正答はこう。", "D = 1 > 0"),
        stepAwaiting(1, "じゃあ、どうしてそうなるか、自分の言葉で説明してみて。", true),
      ]),
    );
    const utterances = new StudentUtterances();
    const recorded: string[] = [];
    const events: string[] = [];

    const result = await loopWith(llm, board, {
      utterances,
      record: (text) => recorded.push(text),
      // 通常待ちなら1msで切れる条件。20ms後の申告を受け取れれば別の待ちを使えている。
      answerTimeoutMs: 1,
      log: {
        info: (event) => events.push(event),
        warn: (event) => events.push(event),
      },
      speak: async (delivered) => {
        if (delivered.awaits_solving === true) {
          setTimeout(() => utterances.push("できた"), 20);
        }
      },
    });

    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(2);
    expect(recorded).toEqual(["できた"]);
    expect(events).not.toContain("lesson_answer_timeout");
    expect(llm.asked[1]).toContain("類題の正答");
    expect(llm.asked[1]).toContain("正解したとは言わない");
    expect(
      sink.sent.some(
        (message) =>
          message.type === "board_step" &&
          message.step.board?.kind === "latex" &&
          message.step.board.tex.includes("D = 1"),
      ),
    ).toBe(true);
  });

  it("完了申告後の生成が失敗しても、同じ申告をもう一度待たない", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([stepSolving(0, "じゃあ、この類題はどうなる?", "x^2 - 5x + 6 = 0")]),
      "",
    );
    const utterances = new StudentUtterances();
    const recorded: string[] = [];

    const result = await loopWith(llm, board, {
      utterances,
      record: (text) => recorded.push(text),
      minContinueSeconds: 0,
      remainingSeconds: () => 0.05,
      speak: async (delivered) => {
        if (delivered.awaits_solving === true) setTimeout(() => utterances.push("できた"), 1);
      },
    });

    expect(result.reason).toBe("error");
    expect(recorded).toEqual(["できた"]);
    expect(llm.asked).toHaveLength(2);
  });

  it("「できなかった」なら止まった場所を聞き、教え直して同じ類題へ戻す", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "流れはこの3つ。", "D = b^2 - 4ac"),
        stepSolving(1, "じゃあ、この類題はどうなる? 解けたら教えて。", "x^2 - 5x + 6 = 0"),
      ]),
      lessonJson([stepAwaiting(0, "そっか。どこで止まった?", true)]),
      lessonJson([
        step(0, "Dの代入だけ一緒にやろう。", "D = (-5)^2 - 4 \\cdot 1 \\cdot 6"),
        stepSolving(1, "同じ類題を、もう一回やってみて。", "x^2 - 5x + 6 = 0"),
      ]),
      lessonJson([
        step(0, "正答はこう。", "D = 1 > 0"),
        stepAwaiting(1, "じゃあ、どうしてそうなるか、自分の言葉で説明してみて。", true),
      ]),
    );
    const utterances = new StudentUtterances();
    const recorded: string[] = [];
    let solvingCount = 0;

    const result = await loopWith(llm, board, {
      utterances,
      record: (text) => recorded.push(text),
      answerTimeoutMs: 100,
      speak: async (delivered) => {
        if (delivered.awaits_solving === true) {
          solvingCount += 1;
          setTimeout(() => utterances.push(solvingCount === 1 ? "できなかった" : "できた"), 5);
        } else if (delivered.speech.includes("どこで止まった")) {
          setTimeout(() => utterances.push("Dに数字を入れるところ"), 5);
        }
      },
    });

    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(4);
    expect(recorded).toEqual(["できなかった", "Dに数字を入れるところ", "できた"]);
    expect(llm.asked[1]).toContain("どこで止まった");
    expect(llm.asked[1]).toContain("責めず");
    expect(llm.asked[2]).toContain("Dに数字を入れるところ");
    const solvingSteps = lessonSteps(result.turns).filter(
      (delivered) => delivered.awaits_solving === true,
    );
    expect(solvingSteps).toHaveLength(2);
    expect(solvingSteps[0]?.board).toEqual(solvingSteps[1]?.board);
  });

  it("問いかけで止まり、答えを受けて同じ板書に続きを積む", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 3x + 2 = 0"),
        step(1, "最小公倍数、何になると思う?"),
        step(2, "ここは読まれない。", "x = 99"),
      ]),
      lessonJson([
        step(0, "そう、12だよね。", "x = 12"),
        step(1, "じゃあ今の、自分の言葉で説明してみて。"),
      ]),
    );

    const utterances = new StudentUtterances();
    const recorded: string[] = [];
    const running = loopWith(llm, board, {
      utterances,
      record: (text) => recorded.push(text),
      // 1パス目が問いかけで止まったら、生徒が答える
      speak: async (delivered) => {
        if (delivered.speech.includes("何になると思う")) {
          setTimeout(() => utterances.push("えっと、12?"), 5);
        }
      },
    });

    const result = await running;

    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(2);
    // 問いかけの先の手順は配送されない(答えを聞く前に自分で埋めない)
    expect(result.step_count).toBe(4);

    // 板書は1枚のまま(開き直しは板書を消す信号になる)
    const opens = sink.sent.filter((message) => message.type === "board_open");
    expect(opens).toHaveLength(1);
    // ワイヤーの index は往復をまたいで通しで増える
    const indexes = sink.sent
      .filter((message) => message.type === "board_step")
      .map((message) => (message.type === "board_step" ? message.step.index : -1));
    expect(indexes).toEqual([0, 1, 2, 3]);

    // 答えは transcript(カルテの材料)に写る
    expect(recorded).toEqual(["えっと、12?"]);
    // 続きの指示には、ここまでのやりとりと答えが入っている
    expect(llm.asked[1]).toContain("えっと、12?");
    expect(llm.asked[1]).toContain("続きだけを書きます");
    // 起きたことの列: 手順2つ → 生徒の答え → 手順2つ
    expect(result.turns.map((turn) => turn.kind)).toEqual([
      "step",
      "step",
      "student",
      "step",
      "step",
    ]);
  });

  /**
   * 残り時間はパスごとに読み直すが、**正本(`system`)は動かさない**。
   * ここが混ざると4万字級の指示文がパスのたびにキャッシュから外れる
   * (`lesson.ts` の `cache_control`)。
   */
  it("正本は据え置いたまま、残り時間だけをパスごとに読み直す", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([stepAwaiting(0, "まず何する? 一言でいいよ。", true)]),
      lessonJson([
        step(0, "そう、そこを因数分解する。", "x^2 - 3x + 2 = 0"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。", true),
      ]),
    );
    const utterances = new StudentUtterances();
    let seconds = 600;

    const result = await loopWith(llm, board, {
      systemTail: () => `この授業の残り時間は ${seconds} 秒です。`,
      utterances,
      speak: async (delivered) => {
        if (delivered.speech.includes("まず何する")) {
          seconds = 480;
          setTimeout(() => utterances.push("因数分解する。"), 5);
        }
      },
    });

    expect(result.passes).toBe(2);
    expect(llm.systems[0]).toBe(llm.systems[1]);
    expect(llm.tails).toEqual([
      "この授業の残り時間は 600 秒です。",
      "この授業の残り時間は 480 秒です。",
    ]);
  });

  /** 先読み合成の差し込み口。素通しの層でも授業の進み方は変わらない。 */
  it("wrapChunks を通してからLLMのチャンクを配送する", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([
        step(0, "まず整理するね。", "x^2 - 3x + 2 = 0"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。", true),
      ]),
    );
    const seen: string[] = [];

    const result = await loopWith(llm, board, {
      wrapChunks: (chunks) =>
        (async function* () {
          for await (const chunk of chunks) {
            seen.push(chunk);
            yield chunk;
          }
        })(),
    });

    expect(result.reason).toBe("handed_over");
    expect(seen.join("")).toContain("まず整理するね。");
  });

  it("音読依頼の直後の発話を覚え、次パスの system へ問題文として渡す", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([stepAwaiting(0, "問題、読んでもらってもいい?", true)]),
      lessonJson([
        step(0, "じゃあ、この式を整理するね。", "x^2 - 3x + 2 = 0"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。", true),
      ]),
    );
    const utterances = new StudentUtterances();
    const spoken = "次の二次方程式 x^2 - 3x + 2 = 0 を解け。";
    let remembered: string | null = null;

    const result = await loopWith(llm, board, {
      system: () => `今日の問題: ${remembered ?? "(問題の写真なし)"}`,
      utterances,
      problemReadoutMemory: {
        isMissing: () => remembered === null,
        remember: (text) => {
          remembered = text;
          return { accepted: true, length: text.length };
        },
      },
      speak: async (delivered) => {
        if (delivered.speech.includes("読んでもらってもいい")) {
          setTimeout(() => utterances.push(spoken), 5);
        }
      },
    });

    expect(result.reason).toBe("handed_over");
    expect(remembered).toBe(spoken);
    expect(llm.systems[0]).toContain("(問題の写真なし)");
    expect(llm.systems[1]).toContain(spoken);
    expect(llm.asked[1]).toContain("問題文の読み上げはもう一度頼みません");
  });

  it("問題文があるのに音読を頼んだパスを、本文なしの縮退ログにする", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(lessonJson([stepAwaiting(0, "問題、読んでもらってもいい?", true)]));
    const infos: { event: string; fields: Record<string, unknown> }[] = [];
    const warnings: { event: string; fields: Record<string, unknown> }[] = [];

    await loopWith(llm, board, {
      remainingSeconds: () => 30,
      problemReadoutMemory: {
        isMissing: () => false,
        remember: () => ({ accepted: false, reason: "already_present" }),
      },
      log: {
        info: (event, fields = {}) => infos.push({ event, fields }),
        warn: (event, fields = {}) => warnings.push({ event, fields }),
      },
    });

    expect(infos).toContainEqual({
      event: "lesson_opening_observed",
      fields: { problem_present: true, problem_readout_requested: true },
    });
    expect(warnings).toContainEqual({
      event: "problem_readout_unexpected",
      fields: {
        pass: 1,
        problem_present: true,
        repeated: false,
        awaits_student: true,
      },
    });
    expect(JSON.stringify(warnings)).not.toContain("問題、読んで");
  });

  it("2パス目でも音読を頼んだら、繰り返しとして観測する", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([stepAwaiting(0, "問題、読んでもらってもいい?", true)]),
      lessonJson([stepAwaiting(0, "もう一度、問題を読んでくれる?", true)]),
    );
    const utterances = new StudentUtterances();
    const warnings: { event: string; fields: Record<string, unknown> }[] = [];
    let remembered = false;

    await loopWith(llm, board, {
      utterances,
      problemReadoutMemory: {
        isMissing: () => !remembered,
        remember: (text) => {
          remembered = true;
          return { accepted: true, length: text.length };
        },
      },
      speak: async (delivered) => {
        if (!remembered && delivered.speech.includes("読んでもらってもいい")) {
          setTimeout(() => utterances.push("x^2 = 4 を解け。"), 5);
        }
      },
      // 2パス目の観測後は答えを待たず、安全弁で終了させる。
      remainingSeconds: () => (llm.systems.length < 2 ? 300 : 0),
      log: {
        info: () => undefined,
        warn: (event, fields = {}) => warnings.push({ event, fields }),
      },
    });

    /**
     * **2回目は観測ではなく、配送前に落とす。**
     *
     * `runBoardLesson` は手順を配送して `speak` を呼んでから返るので、事後に
     * 気づいても**生徒にはもう二度目が届いている**。「毎回読ませる」を直しに来た
     * 変更なので門にしてあり、届かなかった事実だけが warn に残る。
     */
    expect(warnings).toContainEqual({ event: "problem_readout_blocked", fields: { pass: 2 } });
    expect(warnings.map((warning) => warning.event)).not.toContain("problem_readout_unexpected");
  });

  it("2回目の音読依頼は板書にもTTSにも出さない", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([stepAwaiting(0, "問題、読んでもらってもいい?", true)]),
      lessonJson([stepAwaiting(0, "もう一度、問題を読んでくれる?", true)]),
    );
    const utterances = new StudentUtterances();
    const spoken: string[] = [];
    let remembered = false;

    await loopWith(llm, board, {
      utterances,
      problemReadoutMemory: {
        isMissing: () => !remembered,
        remember: (text) => {
          remembered = true;
          return { accepted: true, length: text.length };
        },
      },
      speak: async (delivered) => {
        spoken.push(delivered.speech);
        if (!remembered && delivered.speech.includes("読んでもらってもいい")) {
          setTimeout(() => utterances.push("x^2 = 4 を解け。"), 5);
        }
      },
      remainingSeconds: () => (llm.systems.length < 2 ? 300 : 0),
    });

    // 1回目は届く。2回目はTTSにも板書にも出ない。
    expect(spoken.filter((speech) => speech.includes("読ん"))).toHaveLength(1);
    expect(
      sink.sent.filter(
        (message) => message.type === "board_step" && message.step.speech.includes("もう一度"),
      ),
    ).toHaveLength(0);
  });

  it("説明の途中の発話はパスを中止し、続きのパスで応える(会話へ落とさない)", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 3x + 2 = 0"),
        step(1, "次はこう。", "D = 9 - 8"),
        step(2, "ここまでは読まれない。", "D = 1"),
      ]),
      lessonJson([step(0, "じゃあ今の、自分の言葉で説明してみて。")]),
    );

    const utterances = new StudentUtterances();
    const recorded: string[] = [];
    const result = await loopWith(llm, board, {
      utterances,
      record: (text) => recorded.push(text),
      speak: async (delivered) => {
        // 1手順目の読み上げ中に生徒が口を開く
        if (delivered.index === 0) utterances.push("ちょっと待って、全然わかんない");
      },
    });

    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(2);
    expect(recorded).toEqual(["ちょっと待って、全然わかんない"]);
    expect(llm.asked[1]).toContain("ちょっと待って、全然わかんない");
    // 中止されたパスの残り手順は出ていない
    expect(result.step_count).toBe(2);
  });

  it("答えが来なければ沈黙を記録して続ける(transcriptには写さない)", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([step(0, "この式、まず何する?", "x^2 - 3x + 2 = 0")]),
      lessonJson([
        step(0, "因数分解からいくね。", "(x-1)(x-2) = 0"),
        step(1, "じゃあ今の、自分の言葉で説明してみて。"),
      ]),
    );

    const recorded: string[] = [];
    const result = await loopWith(llm, board, {
      record: (text) => recorded.push(text),
      answerTimeoutMs: 5,
    });

    expect(result.reason).toBe("handed_over");
    expect(recorded).toEqual([]);
    expect(
      result.turns.some(
        (turn) => turn.kind === "student" && turn.text === studentSilenceMarker("ja"),
      ),
    ).toBe(true);
    // 続きの指示に「返事はなかった」が入り、次のパスが軽く自分で答えて進める
    expect(llm.asked[1]).toContain(studentSilenceMarker("ja"));
  });

  it("「説明してみて」で終わったら、答えを待たずに教え返しへ渡す", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([
        step(0, "この形だったよね。", "D = b^2 - 4ac"),
        step(1, "じゃあ今の、自分の言葉で説明してみて。"),
      ]),
    );

    const result = await loopWith(llm, board);

    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(1);
  });

  it("問いかけず言い切って終えたら completed(呼び出し側が定型句で戻す)", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(lessonJson([step(0, "この形にすると頂点が見えるよ。", "y = (x-1)^2")]));

    const result = await loopWith(llm, board);

    expect(result.reason).toBe("completed");
    expect(result.passes).toBe(1);
  });

  /**
   * **「板書がイニシャルのステートで止まる」の回帰テスト。**
   *
   * 「まず何する? 一言でいいよ。」は板書プロンプトの見本そのものだが、`?` が
   * 文中に沈むので言い回しの推測(`handsTurnToStudent`)では拾えない。推測だけ
   * だった頃はここで「渡し忘れ(completed)」と誤読して授業ループごと終わり、
   * 以降のセッションは音声だけ・板書は最初の数行のまま凍っていた。
   * `awaits_student: true` の申告があれば、言い回しに関わらず答えを待って続く。
   */
  it("言い回しが推測に掛からない問いかけでも、awaits_student の申告で答えを待って続く", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 3x + 2 < 0"),
        stepAwaiting(1, "オッケー。じゃあこの式、まず何する? 一言でいいよ。", true),
      ]),
      lessonJson([
        step(0, "そう、因数分解からいこう。", "(x-1)(x-2) < 0"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。", true),
      ]),
    );

    const utterances = new StudentUtterances();
    const result = await loopWith(llm, board, {
      utterances,
      speak: async (delivered) => {
        if (delivered.speech.includes("まず何する")) {
          setTimeout(() => utterances.push("因数分解…?"), 5);
        }
      },
    });

    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(2);
    // 同じ板書に積まれ続けている(completed で途切れていない)
    expect(sink.sent.filter((message) => message.type === "board_open")).toHaveLength(1);
    expect(result.step_count).toBe(4);
  });

  it("答え待ちの問いは、本文を出さず板書の有無と種類を観測する", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([stepAwaitingWithQuestion(0, "1行目の D、符号はどれ?", "1行目の D の符号は?")]),
      // プロンプトから外れた `board: null` も拒否せず、割合を測れる形で記録する。
      lessonJson([stepAwaiting(0, "2行目から3行目、何をした?", true)]),
      lessonJson([stepAwaiting(0, "じゃあ今の、自分の言葉で説明してみて。", true)]),
    );
    const observations: Record<string, unknown>[] = [];
    const utterances = new StudentUtterances();

    const result = await loopWith(llm, board, {
      utterances,
      log: {
        info: (event: string, fields: Record<string, unknown> = {}) => {
          if (event === "lesson_awaiting_question_board") observations.push(fields);
        },
        warn: (_event: string) => undefined,
      },
      speak: async (delivered) => {
        if (!delivered.speech.includes("説明して")) {
          setTimeout(() => utterances.push("答え"), 5);
        }
      },
    });

    expect(result.reason).toBe("handed_over");
    expect(observations).toEqual([
      { pass: 1, board_kind: "text", board_missing: false },
      { pass: 2, board_kind: "none", board_missing: true },
    ]);
  });

  /**
   * **手順を1つも配送しなかったパスは、前の問いを数え直さない。**
   *
   * 生成が空で終わる回(ストリーム失敗・即割り込み)に累積の `turns` を見ると、
   * 末尾は前のパスの問いのままなので、同じ問いが新しいパス番号でもう一度載る。
   * 測ろうとしている `board_missing` の割合が、その二重計上ぶんだけ歪む。
   */
  it("手順が出せなかったパスでは、前の問いを二重に数えない", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([stepAwaiting(0, "2行目から3行目、何をした?", true)]),
      // 2パス目は空(生成が壊れた回)。板書には何も積まれない。
      "",
    );
    const observations: Record<string, unknown>[] = [];
    const utterances = new StudentUtterances();

    await loopWith(llm, board, {
      utterances,
      maxPasses: 2,
      log: {
        info: (event: string, fields: Record<string, unknown> = {}) => {
          if (event === "lesson_awaiting_question_board") observations.push(fields);
        },
        warn: (_event: string) => undefined,
      },
      speak: async () => {
        setTimeout(() => utterances.push("答え"), 5);
      },
    });

    expect(observations).toEqual([{ pass: 1, board_kind: "none", board_missing: true }]);
  });

  it("修辞疑問(awaits_student: false)では止まらず、そのまま教え続ける", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([
        // 末尾が ? なので推測なら止まる形。false の申告が勝つ(#105 の症状A)。
        stepAwaiting(0, "まず(1)からやろっか?", false, "x^2 - 3x + 2 = 0"),
        step(1, "判別式はこの形だったよね。", "D = b^2 - 4ac"),
        stepAwaiting(2, "じゃあ今の、自分の言葉で説明してみて。", true),
      ]),
    );

    const result = await loopWith(llm, board);

    // 1手順目で止まらず、1パスで教え返しまで届いている
    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(1);
    expect(result.step_count).toBe(3);
  });

  /**
   * 途中の手順が直せずに落ちても、**そこまで積めた板書を道連れにしない。**
   * 積めた手順は有効で板書も開いたまま — 次のパスは recap を持って続きを書ける。
   * 以前はここで授業ごと降りていて、1回の検証落ちが残りの授業を丸ごと潰していた。
   */
  it("失敗したパスでも手順が積めていれば、同じ板書で続きのパスに入る", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 3x + 2 = 0"),
        // 2手順目は日本語入りのLaTeXで検証に落ちる(作り直しもJSONではない)
        step(1, "よって、こう。", "\\text{よって} x = 2"),
      ]),
      lessonJson([
        step(0, "続きね。判別式はこの形。", "D = b^2 - 4ac"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。", true),
      ]),
    );

    const result = await loopWith(llm, board);

    expect(result.reason).toBe("handed_over");
    expect(result.passes).toBe(2);
    // 1パス目の1手順 + 2パス目の2手順が同じ板書に載っている
    expect(sink.sent.filter((message) => message.type === "board_open")).toHaveLength(1);
    expect(result.step_count).toBe(3);
    // 続きの指示は「切れたところから」の形(生徒は何も言っていない)。
    // asked[1] は落ちた手順の作り直し依頼なので、最後の呼び出しを見る。
    expect(llm.asked.at(-1)).toContain("説明は途中で切れています");
  });

  it("再入(priorTurns)では最初のパスから継続の指示になる(授業を最初から書き直させない)", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "ここが聞かれてたとこ。もう一回書くね。", "D = b^2 - 4ac"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。", true),
      ]),
    );

    const result = await loopWith(llm, board, {
      priorTurns: [
        {
          kind: "step",
          step: { index: 0, speech: "まず、式をそのまま書くね。", board: null },
        },
        { kind: "student", text: "板書して!" },
      ],
    });

    expect(result.reason).toBe("handed_over");
    // 初回の定型指示ではなく、これまでのやりとり入りの継続指示で呼ばれている
    expect(llm.asked[0]).toContain("板書して!");
    expect(llm.asked[0]).toContain("続きだけを書きます");
    // 戻りの列には、渡した文脈と新しい手順の両方が入っている
    expect(result.turns.map((turn) => turn.kind)).toEqual(["step", "student", "step", "step"]);
  });

  it("往復の上限で降りるとき、積み残しの発話は取り出さない", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 3x + 2 = 0"),
        step(1, "最小公倍数、何になると思う?"),
      ]),
    );

    const utterances = new StudentUtterances();
    const recorded: string[] = [];
    const result = await loopWith(llm, board, {
      utterances,
      record: (text) => recorded.push(text),
      maxPasses: 1,
      speak: async (delivered) => {
        if (delivered.index === 1) utterances.push("うーん、6?");
      },
    });

    expect(result.reason).toBe("budget");
    expect(result.passes).toBe(1);
    // 発話は残したまま。記録も返事も、板書の要約を持つ会話モードが引き取る
    expect(recorded).toEqual([]);
    expect(utterances.pending).toBe(true);
  });

  it("残り時間が少なければ類題を送信前に省き、従来の教え返しへ縮退する", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 3x + 2 = 0"),
        stepSolving(1, "じゃあ、この類題はどうなる?", "x^2 - 5x + 6 = 0"),
      ]),
    );

    const result = await loopWith(llm, board, {
      remainingSeconds: () => 30,
    });

    expect(result.reason).toBe("budget");
    expect(result.passes).toBe(1);
    expect(
      sink.sent.some(
        (message) =>
          message.type === "board_step" &&
          message.step.board?.kind === "latex" &&
          message.step.board.tex.includes("x^2 - 5x"),
      ),
    ).toBe(false);
    expect(lessonSteps(result.turns).some((delivered) => delivered.awaits_solving === true)).toBe(
      false,
    );
    expect(teachBackFallback({ locale: "ja" }, lessonSteps(result.turns))).toBe(
      teachBackPrompt("ja"),
    );
  });

  it("復習では残り時間があっても類題を送らず、従来の教え返しへ縮退する", async () => {
    const sink = recordingSink();
    const board = boardWith(sink);
    const llm = stubLlm(
      lessonJson([
        step(0, "平方完成すると頂点が見える。", "(x + 3)^2 - 9"),
        stepSolving(1, "じゃあ、この類題はどうなる?", "x^2 + 4x + 1"),
      ]),
    );

    const result = await loopWith(llm, board, { practiceProblemEnabled: false });

    expect(result.reason).toBe("budget");
    expect(lessonSteps(result.turns).some((delivered) => delivered.awaits_solving === true)).toBe(
      false,
    );
    expect(
      sink.sent.some(
        (message) =>
          message.type === "board_step" &&
          message.step.board?.kind === "latex" &&
          message.step.board.tex.includes("x^2 + 4x"),
      ),
    ).toBe(false);
    expect(teachBackFallback({ locale: "ja" }, lessonSteps(result.turns))).toBe(
      teachBackPrompt("ja"),
    );
  });

  it("類題の待機はセッション残り時間だけを安全弁にする", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([stepSolving(0, "じゃあ、この類題はどうなる?", "x^2 - 5x + 6 = 0")]),
    );
    const events: string[] = [];

    const result = await loopWith(llm, board, {
      // 類題は出せる設定にし、20msぶんのセッション残り時間だけで待ちを閉じる。
      minContinueSeconds: 0,
      remainingSeconds: () => 0.02,
      answerTimeoutMs: 1,
      log: {
        info: (event) => events.push(event),
        warn: (event) => events.push(event),
      },
    });

    expect(result.reason).toBe("interrupted");
    expect(events).toContain("lesson_solving_deadline");
    expect(events).not.toContain("lesson_answer_timeout");
  });

  it("答えを待っている間にセッションが終わったら、すぐ降りる", async () => {
    const board = boardWith(recordingSink());
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 3x + 2 = 0"),
        step(1, "この式、まず何する?"),
      ]),
    );

    const ended = new AbortController();
    const running = loopWith(llm, board, {
      signal: ended.signal,
      answerTimeoutMs: 60_000,
      speak: async (delivered) => {
        if (delivered.index === 1) setTimeout(() => ended.abort(), 5);
      },
    });

    const result = await running;
    expect(result.reason).toBe("interrupted");
  });

  it("作り直しが効かないパスで降りる(往復を続けても同じ失敗の族に落ちる)", async () => {
    const board = boardWith(recordingSink());
    // 数式に日本語を入れると弾かれる。作り直しもJSONではないので諦める。
    const llm = stubLlm(
      lessonJson([step(0, "よって、こう。", "\\text{よって} x = 2")]),
      "無理でした",
    );

    const result = await loopWith(llm, board);

    expect(result.reason).toBe("error");
    expect(result.passes).toBe(1);
    expect(result.step_count).toBe(0);
  });
});
