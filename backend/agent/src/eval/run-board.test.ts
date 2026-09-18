import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardChannelMessage } from "@ai-sensei/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LessonLlm } from "../lesson.ts";
import { boardSystemPrompt, defaultRemainingSeconds, runBoardTrial } from "./run-board.ts";
import { type EvalScenario, findScenario } from "./scenario.ts";
import { promptSha256, readTrial, trialPath } from "./trial.ts";

/**
 * L1ランナーのテスト。**実ネットワークを一切使わない**(stub `LessonLlm` を注入)。
 *
 * 見たいのは4つ:
 *   1. 封筒が実ワイヤー形式で集まり、レコードが保存されて `metrics` が埋まること
 *   2. 番の受け渡し(`awaits_student`)でその回の説明が止まること
 *   3. **作り直しを1回も呼ばないこと**(落ちた手順を数えるのが目的)
 *   4. 例外でも部分レコードが残ること
 */

const scenario = findScenario("math_quadratic", "ja") as EvalScenario;
const topicId = scenario.context.allowed_topic_ids[0];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-run-board-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lessonJson(steps: readonly unknown[]): string {
  return JSON.stringify({ title: "二次方程式を因数分解で解く", topic_ids: [topicId], steps });
}

/** 呼ばれた `user`(指示)を記録するstub。**呼ばれた回数が作り直しの検出になる。** */
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
        // チャンクの切れ目に意味を持たせない(実ストリームと同じ)。
        for (const part of output.match(/[\s\S]{1,9}/g) ?? []) {
          await Promise.resolve();
          yield part;
        }
      })();
    },
  };
}

/** 決定的な時計。1回呼ぶごとに 100ms 進む。 */
function fakeClock(): () => number {
  let at = 1_000;
  return () => {
    at += 100;
    return at;
  };
}

const lesson = lessonJson([
  {
    index: 0,
    speech: "まず、式をそのまま書くね。",
    board: { kind: "latex", tex: "x^2 - 5x + 6 = 0" },
  },
  {
    index: 1,
    speech: "因数分解すると、こうなる。",
    board: { kind: "latex", tex: "(x-2)(x-3) = 0" },
  },
  { index: 2, speech: "じゃあ今の、自分の言葉で説明してみて。", board: null, awaits_student: true },
]);

describe("runBoardTrial", () => {
  it("封筒を集め、レコードを保存して metrics まで埋める", async () => {
    const llm = stubLlm(lesson);
    const record = await runBoardTrial({
      scenario,
      trial: 1,
      llm,
      model: "stub-model",
      runDir: dir,
      now: fakeClock(),
    });

    // 保存されたものと返り値が一致する(集計は必ずファイル側を読む)。
    const path = trialPath(dir, { scenario_id: "math_quadratic", locale: "ja", trial: 1 });
    expect(readTrial(path)).toEqual(record);

    // 実ワイヤー形式の封筒。板書は1枚で、開くのは1回だけ。
    const envelopes = record.envelopes as BoardChannelMessage[];
    expect(envelopes.map((message) => message.type)).toEqual([
      "board_open",
      "board_step",
      "board_step",
      "board_step",
    ]);
    expect(envelopes.map((message) => message.seq)).toEqual([0, 1, 2, 3]);
    expect(envelopes[0]).toMatchObject({ v: 1, board_id: "brd_eval_math_quadratic.ja_t1" });

    expect(record.meta.model).toBe("stub-model");
    expect(record.meta.prompt_sha256).toBe(promptSha256(boardSystemPrompt(scenario)));
    expect(record.system_prompt).toBe(boardSystemPrompt(scenario, defaultRemainingSeconds));
    expect(record.meta.time_to_first_step_ms).toBeGreaterThan(0);
    expect(record.loop).toEqual({ reason: "completed", passes: 1, step_count: 3, opened: true });

    expect(record.metrics?.ok).toBe(true);
    expect(record.metrics?.steps_total).toBe(3);
    expect(record.metrics?.wrote_on_board).toBe(true);
    expect(record.metrics?.last_step).toBe("teach_back");
    expect(record.metrics?.awaits_declared).toBe(1);
    expect(record.metrics?.rejections_total).toBe(0);
    // L1に授業の往復は無いので、L2だけの指標は欄そのものを出さない。
    expect(record.metrics?.loop_reason).toBeUndefined();
    expect(record.metrics?.passes).toBeUndefined();
  });

  it("番を渡した手順で止まり、その先は配送しない", async () => {
    const llm = stubLlm(
      lessonJson([
        { index: 0, speech: "まず、何をすると思う?", board: null, awaits_student: true },
        { index: 1, speech: "ここは配送されない。", board: { kind: "latex", tex: "x = 2" } },
      ]),
    );
    const record = await runBoardTrial({
      scenario,
      trial: 1,
      llm,
      model: "stub-model",
      runDir: dir,
      now: fakeClock(),
    });

    expect(record.metrics?.steps_total).toBe(1);
    expect(record.metrics?.last_step).toBe("awaits_student");
    // 音声だけの手順しか出ていない = 生徒の画面は見出しだけ。
    expect(record.metrics?.wrote_on_board).toBe(false);
    expect(record.metrics?.board_null_ratio).toBe(1);
  });

  it("落ちた手順は作り直させずに数える(LLMを2回呼ばない)", async () => {
    const llm = stubLlm(
      lessonJson([
        {
          index: 0,
          speech: "まず、式をそのまま書くね。",
          board: { kind: "latex", tex: "x^2 = 4" },
        },
        // `speech` は120字まで。契約違反なのでワイヤーに出ない。
        { index: 1, speech: "あ".repeat(200), board: null },
      ]),
    );
    const record = await runBoardTrial({
      scenario,
      trial: 2,
      llm,
      model: "stub-model",
      runDir: dir,
      now: fakeClock(),
    });

    expect(llm.asked).toHaveLength(1);
    expect(record.rejections.map((rejection) => rejection.reason)).toEqual(["schema"]);
    expect(record.metrics?.rejections_by_reason).toEqual({ schema: 1 });
    expect(record.metrics?.steps_total).toBe(1);
    // 直さずに降りた回は「最後まで走った」ではない。
    expect(record.loop?.reason).toBe("error");
    expect(record.metrics?.ok).toBe(false);
    expect(record.error).toBeUndefined();
  });

  it("例外でも部分レコードを残す(errorつきで保存)", async () => {
    // 1チャンクも来ないまま上流が落ちる(429・タイムアウト)。実物も
    // `createAnthropicLessonClient` の最初の `next()` で投げる形になる。
    const llm: LessonLlm = {
      stream() {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("板書の生成に失敗しました: 429 rate limit")),
          }),
        };
      },
    };
    const record = await runBoardTrial({
      scenario,
      trial: 3,
      llm,
      model: "stub-model",
      runDir: dir,
      now: fakeClock(),
    });

    // 例外は投げない。**払ったぶんの記録を捨てない**のがこの関数の契約。
    expect(record.error).toContain("429");
    expect(record.turns).toEqual([]);
    expect(record.envelopes).toEqual([]);
    expect(record.metrics?.ok).toBe(false);
    expect(record.metrics?.last_step).toBe("none");
    expect(readTrial(trialPath(dir, record.meta)).error).toContain("429");
  });

  it("モデルの出力が壊れた回は error に入れない(通信の失敗と混ぜない)", async () => {
    // ルートの `}` まで来ないまま切れた出力。`BoardStreamError` ではなく
    // `board_stream_truncated` になる経路で、どちらもモデルの成績。
    const llm = stubLlm('{"title":"途中で切れた","topic_ids":["');
    const record = await runBoardTrial({
      scenario,
      trial: 4,
      llm,
      model: "stub-model",
      runDir: dir,
      now: fakeClock(),
    });

    expect(record.error).toBeUndefined();
    expect(record.metrics?.ok).toBe(false);
    expect(record.metrics?.steps_total).toBe(0);
    expect(record.loop?.opened).toBe(false);
  });
});

describe("boardSystemPrompt", () => {
  it("残り時間は既定の固定値(同じプロンプトなら sha256 が動かない)", () => {
    expect(defaultRemainingSeconds).toBe(600);
    expect(promptSha256(boardSystemPrompt(scenario))).toBe(
      promptSha256(boardSystemPrompt(scenario, defaultRemainingSeconds)),
    );
    expect(promptSha256(boardSystemPrompt(scenario))).not.toBe(
      promptSha256(boardSystemPrompt(scenario, 60)),
    );
  });
});
