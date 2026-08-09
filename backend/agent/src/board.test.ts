import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type BoardChannelMessage,
  type BoardStep,
  boardChannelLogSchema,
  boardChannelTopic,
  boardStepsMaxCount,
  fixturePath,
} from "@ai-sensei/contract";
import { latexRejectionGuidanceByLocale } from "@ai-sensei/guardrail";
import { describe, expect, it, vi } from "vitest";
import {
  BoardChannel,
  type BoardSink,
  type BoardStepRejection,
  createTextStreamBoardSink,
  defaultMaxRepairAttempts,
  validateStep,
} from "./board.ts";

/**
 * 配送層のテスト。**「動くこと」ではなく「壊れたときに壊れたと分かること」**を見る。
 *
 * 見たいのは4つ:
 *   1. 手順が閉じた端から出ていること(まとめて出ていないこと)
 *   2. 検証に落ちた手順が**ワイヤーに出ないこと**
 *   3. `seq` / `index` / `step_count` が、受信側の欠落検知として機能すること
 *   4. 割り込みで、板書が途中まで残る形に締まること
 */

const step = (index: number, tex: string): unknown => ({
  index,
  speech: `${index}番目。ここ、見てほしいんだけど。`,
  board: { kind: "latex", tex },
});

function lessonJson(steps: readonly unknown[], title = "判別式で解の個数を見る"): string {
  return JSON.stringify({ title, topic_ids: ["M1-NIJI-HANBETSU"], steps });
}

/** チャンクの切れ目に意味を持たせない。 */
function slice(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts;
}

async function* stream(parts: readonly string[], onBeforeYield?: (at: number) => void) {
  for (const [at, part] of parts.entries()) {
    onBeforeYield?.(at);
    // 実際のLLMストリームと同じく、チャンクの間にイベントループを挟む
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

function channelWith(sink: BoardSink, locale: "ja" | "en" = "ja"): BoardChannel {
  let issued = 0;
  return new BoardChannel({
    sessionId: "ses_1",
    locale,
    sink,
    newBoardId: () => {
      issued += 1;
      return `brd_${issued}`;
    },
  });
}

const typesOf = (sent: readonly BoardChannelMessage[]) => sent.map((message) => message.type);
const texOf = (sent: readonly BoardChannelMessage[]) =>
  sent.flatMap((message) =>
    message.type === "board_step" && message.step.board?.kind === "latex"
      ? [message.step.board.tex]
      : [],
  );

describe("BoardChannel.deliver(正常系)", () => {
  it("board_open → board_step × n → board_close の順で送る", async () => {
    const sink = recordingSink();
    const result = await channelWith(sink).deliver({
      chunks: stream(slice(lessonJson([step(0, "x^2 - 3x + 2 = 0"), step(1, "D = 9 - 8 = 1")]), 7)),
    });

    expect(typesOf(sink.sent)).toEqual(["board_open", "board_step", "board_step", "board_close"]);
    expect(result).toMatchObject({ opened: true, step_count: 2, reason: "completed" });
    // 送った列そのものが契約(順序・seq・index・step_count)を満たす
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  it("seq は種別をまたいで0始まり1ずつ", async () => {
    const sink = recordingSink();
    await channelWith(sink).deliver({
      chunks: stream(slice(lessonJson([step(0, "x = 1"), step(1, "y = 2"), step(2, "z = 3")]), 5)),
    });

    expect(sink.sent.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * **`seq` はセッションの通し番号**(contract の `envelopeFields`)。
   * 板書ごとにリセットすると、2枚目の `board_open` で受信側が「巻き戻った」と見る。
   */
  it("2枚目の板書でも seq は続きから振る", async () => {
    const sink = recordingSink();
    const channel = channelWith(sink);

    await channel.deliver({ chunks: stream([lessonJson([step(0, "x = 1")], "1問目")]) });
    await channel.deliver({ chunks: stream([lessonJson([step(0, "y = 2")], "2問目")]) });

    expect(sink.sent.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(sink.sent.map((message) => message.board_id)).size).toBe(2);
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * **案A(§3-2)の核心が配送層まで届いていること。**
   * 全部揃うのを待って一気に送っているなら、最後のチャンクの直前まで
   * 送信数は0のままになる。
   */
  it("手順が閉じた端から送る(全部揃うのを待たない)", async () => {
    const sink = recordingSink();
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2"), step(2, "z = 3")]);
    const parts = slice(json, 1);
    const sentBefore: number[] = [];

    await channelWith(sink).deliver({
      chunks: stream(parts, () => sentBefore.push(sink.sent.length)),
    });

    // 最後のチャンクを食べる前に、既に open + 手順3つが出ている
    // (`]` で最後の手順が閉じ、`}` はそのあとに来る)。まとめて送っているなら
    // ここは0のままになる。
    expect(sentBefore.at(-1)).toBe(4);
    // 「最初の手順が出るまで」が短いことも見る。全チャンクの半分より前に1つ目が出る。
    expect(sentBefore.findIndex((count) => count >= 2)).toBeLessThan(parts.length / 2);
    expect(typesOf(sink.sent)).toEqual([
      "board_open",
      "board_step",
      "board_step",
      "board_step",
      "board_close",
    ]);
  });

  // 音声が板書を追い越すと「ここ、見て」が空の盤面を指す(§3-2)
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

    await channelWith(trackingSink).deliver({
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
/* 検証に落ちた手順                                                            */
/* -------------------------------------------------------------------------- */

describe("BoardChannel.deliver(描けない式)", () => {
  // `\text{}` の日本語は tofu になる(§3-6d)。LLMが最もやりたがる書き方。
  const rejected = "\\text{よって} x = 2";

  it("弾かれた式はワイヤーに出ない(再生成しない設定)", async () => {
    const sink = recordingSink();
    const result = await channelWith(sink).deliver({
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
   * 落ちても **`board_open` を送り直さない**。契約上、板書が消えるのは
   * `board_open` が来たときだけなので、送り直すと画面が白紙に戻る。
   * ここは「閉じるだけ」で、そこまでの板書は残す。
   */
  it("落ちても板書は作り直さない(そこまでを残して閉じる)", async () => {
    const sink = recordingSink();
    await channelWith(sink).deliver({
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

    await channelWith(sink).deliver({
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
    // 「行き先」が書かれていること(使うな、で終わると別の書き方に逃げて空回りする)
    expect(seen[0]?.guidance).toContain("text の板書");
    expect(seen[0]?.index).toBe(0);
  });

  it("英語のセッションには英語の指示を渡す", async () => {
    const sink = recordingSink();
    let guidance = "";

    await channelWith(sink, "en").deliver({
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
   * **採用した案(b)そのもの。**落ちた手順だけ直させ、送信済みの手順は
   * 有効なまま、続きを送る。
   */
  it("直った手順は送られ、その前後の手順は影響を受けない", async () => {
    const sink = recordingSink();
    const repair = vi.fn(async (rejection: BoardStepRejection) => ({
      index: rejection.index,
      speech: "よって、こうなるね。",
      board: { kind: "text", body: "よって x = 2" },
    }));

    const result = await channelWith(sink).deliver({
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
    // 直したぶんも含めて、index は詰まったまま0始まり1ずつ
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
    // 落ちた事実は結果に残る(プロンプト調整の材料)
    expect(result.rejections.map((entry) => entry.reason)).toEqual(["text_in_math"]);
  });

  it("直しても直らなければ、上限回数で諦める", async () => {
    const sink = recordingSink();
    const repair = vi.fn(async () => step(9, rejected));

    const result = await channelWith(sink).deliver({
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
   * **既定は1回。**1手順の音声は実測で2〜5秒(`board-lesson.json` の中央値14字 ≒ 2.5秒)で、
   * 再生成1回はほぼ手順1つぶんの間にあたる。2回目に渡す材料は1回目と同じ固定文面なので、
   * **新しい情報のない再試行に、手順1つぶんの沈黙を払うことになる**。
   * ここを増やすときは、指示文が枝分かれして「2回目は別の言い方をする」形に
   * なってからにすること。
   */
  it("既定では1回しか直させない", async () => {
    const sink = recordingSink();
    const repair = vi.fn(async () => step(0, rejected));

    await channelWith(sink).deliver({
      chunks: stream([lessonJson([step(0, rejected)])]),
      repair,
    });

    expect(defaultMaxRepairAttempts).toBe(1);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("直させる側が落ちても、板書は締まる", async () => {
    const sink = recordingSink();
    const result = await channelWith(sink).deliver({
      chunks: stream([lessonJson([step(0, rejected)])]),
      repair: async () => {
        throw new Error("LLMが落ちた");
      },
    });

    expect(typesOf(sink.sent)).toEqual(["board_open", "board_close"]);
    expect(result).toMatchObject({ step_count: 0, reason: "error" });
  });

  it("契約に合わない手順も、ワイヤーに出る前に落とす", async () => {
    const sink = recordingSink();
    const seen: BoardStepRejection[] = [];

    // speech に数式(LaTeXコマンド)を入れている = 板書に置くべきものを喋らせている
    const result = await channelWith(sink).deliver({
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
    expect(typesOf(sink.sent)).toEqual(["board_open", "board_close"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 割り込み                                                                    */
/* -------------------------------------------------------------------------- */

describe("BoardChannel.deliver(割り込み)", () => {
  it("割り込んだら interrupted で締め、step_count は送った数と一致する", async () => {
    const sink = recordingSink();
    const controller = new AbortController();
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2"), step(2, "z = 3")]);

    // 2手順ぶん送れたところで割り込む
    const chunks = stream(slice(json, 1), () => {
      if (sink.sent.length === 3) controller.abort();
    });

    const result = await channelWith(sink).deliver({ chunks, signal: controller.signal });

    expect(result.reason).toBe("interrupted");
    expect(result.step_count).toBe(2);
    const close = sink.sent.at(-1);
    expect(close).toMatchObject({ type: "board_close", reason: "interrupted", step_count: 2 });
    // 板書は途中まで残る(§3-2 案Aの利点そのもの)
    expect(typesOf(sink.sent)).toEqual(["board_open", "board_step", "board_step", "board_close"]);
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * 割り込みは「次のチャンクが来たら気づく」では遅い。生徒はもう喋っている。
   * LLMが黙り込んだままでも締まること。
   */
  it("チャンクを待っている最中の割り込みでも締まる", async () => {
    const sink = recordingSink();
    const controller = new AbortController();

    async function* stalling() {
      yield lessonJson([step(0, "x = 1")]).slice(0, 90);
      // ここから先は永久に来ない
      await new Promise(() => undefined);
      yield "";
    }

    const delivery = channelWith(sink).deliver({
      chunks: stalling(),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const result = await delivery;
    expect(result.reason).toBe("interrupted");
    expect(sink.sent.at(-1)).toMatchObject({ type: "board_close", reason: "interrupted" });
  });

  it("開く前に割り込まれたら、何も送らない", async () => {
    const sink = recordingSink();
    const controller = new AbortController();
    controller.abort();

    const result = await channelWith(sink).deliver({
      chunks: stream([lessonJson([step(0, "x = 1")])]),
      signal: controller.signal,
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, step_count: 0, reason: "interrupted" });
  });
});

/* -------------------------------------------------------------------------- */
/* 壊れたときに壊れたと分かること                                              */
/* -------------------------------------------------------------------------- */

describe("BoardChannel.deliver(壊れ方)", () => {
  it("途中で切れたストリームは completed にしない", async () => {
    const sink = recordingSink();
    const json = lessonJson([step(0, "x = 1"), step(1, "y = 2")]);

    const result = await channelWith(sink).deliver({
      chunks: stream(slice(json.slice(0, json.length - 20), 13)),
    });

    expect(result).toMatchObject({ step_count: 1, reason: "error" });
    expect(sink.sent.at(-1)).toMatchObject({ reason: "error", step_count: 1 });
  });

  it("ヘッダが来ないまま終わったら、1件も送らない", async () => {
    const sink = recordingSink();
    const result = await channelWith(sink).deliver({
      chunks: stream([JSON.stringify({ steps: [step(0, "x = 1")] })]),
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, step_count: 0, reason: "error" });
  });

  // 壊れた板書を開くくらいなら、1枚も開かないほうがよい
  it("見出しが契約に合わなければ、板書を開かない", async () => {
    const sink = recordingSink();
    const result = await channelWith(sink).deliver({
      chunks: stream([JSON.stringify({ title: "", topic_ids: [], steps: [step(0, "x = 1")] })]),
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, reason: "error" });
  });

  /**
   * **「1行ずつだが40行」で答案を丸ごと流し込む抜け道**(contract の `boardStepsMaxCount`)を、
   * 送る前に閉じる。上限を超えた手順は1つもワイヤーに出ない。
   */
  it("12手順を超えたら、そこで止めて閉じる", async () => {
    const sink = recordingSink();
    const many = Array.from({ length: boardStepsMaxCount + 3 }, (_, at) => step(at, `x = ${at}`));

    const result = await channelWith(sink).deliver({ chunks: stream(slice(lessonJson(many), 20)) });

    expect(result).toMatchObject({ step_count: boardStepsMaxCount, reason: "error" });
    expect(sink.sent.filter((message) => message.type === "board_step")).toHaveLength(
      boardStepsMaxCount,
    );
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  /**
   * `index` は「板書の何行目に積むか」という配送の事実。LLMの数え間違いを
   * 流すと、**受信側は正しく届いた板書を「抜けている」と判定する**。
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

    await channel.deliver({
      chunks: stream([lessonJson([step(0, "x = 1"), step(7, "y = 2"), step(1, "z = 3")])]),
    });

    expect(
      sink.sent.flatMap((message) => (message.type === "board_step" ? [message.step.index] : [])),
    ).toEqual([0, 1, 2]);
    expect(warn).toHaveBeenCalledWith("board_step_index_overridden", { declared: 7, index: 1 });
    expect(boardChannelLogSchema.safeParse({ messages: sink.sent }).success).toBe(true);
  });

  it("JSONではないものが流れてきたら、開かずに終わる", async () => {
    const sink = recordingSink();
    const result = await channelWith(sink).deliver({
      chunks: stream(["すみません、板書は作れませんでした。"]),
    });

    expect(sink.sent).toEqual([]);
    expect(result).toMatchObject({ opened: false, reason: "error" });
  });

  /**
   * 送れなかった封筒で `seq` を消費すると、受信側からは「1つ欠けた板書」に見えて
   * 次の手順まで巻き添えにする。
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
    const result = await channel.deliver({ chunks: stream([lessonJson([step(0, "x = 1")])]) });

    expect(result).toMatchObject({ step_count: 0, reason: "error" });
    expect(sent.map((message) => message.seq)).toEqual([0, 1]);
    expect(typesOf(sent)).toEqual(["board_open", "board_close"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 部品                                                                        */
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
/* 契約のfixtureを、そのまま配管に通す                                         */
/* -------------------------------------------------------------------------- */

/**
 * `board-lesson` のfixtureは「LLMがこう出す」という契約側の見本。
 * **それが配送層をそのまま通り抜けること**を固定しておく。
 *
 * ここが落ちるのは、fixtureに `packages/guardrail` が描けない式が入ったとき
 * (= 契約の見本と、実際に送れるものがずれたとき)。そのずれは
 * fixtureのパーステスト(contract側)だけでは絶対に出ない。
 */
describe("契約のfixture", () => {
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
  const load = (name: string): string => readFileSync(resolve(repoRoot, fixturePath(name)), "utf8");

  for (const name of ["board-lesson", "board-lesson.en"]) {
    it(`${name} は1手順も落とさずにワイヤーへ出る`, async () => {
      const json = load(name);
      const lesson = JSON.parse(json) as { title: string; steps: unknown[] };
      const sink = recordingSink();

      const result = await channelWith(sink, name.endsWith(".en") ? "en" : "ja").deliver({
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
  // 生の publishData は使わない(既定が LOSSY で、書き忘れると板書が黙って欠ける・§3-5)
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
