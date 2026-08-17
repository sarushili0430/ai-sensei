import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { studentSilenceMarker } from "../senpai.ts";
import { scoreTrial, speechNearLimit, texOverLength } from "./score.ts";
import { type TrialRecord, promptSha256, trialRecordSchema, trialSchemaVersion } from "./trial.ts";

/**
 * 決定的スコアラーのテスト。**手作りのレコード**で1指標ずつ見る。
 *
 * 判定そのもの(`stepAwaitsStudent` など)は `senpai.test.ts` の担当で、ここが
 * 見るのは**数え方**。指標の意味を取り違えていると、before/after の比較が
 * 静かに逆を指す。
 */

const step = (overrides: Partial<BoardStep> = {}): BoardStep => ({
  index: 0,
  speech: "ここ、見てほしいんだけど。",
  board: { kind: "latex", tex: "x^2 = 4" },
  ...overrides,
});

function record(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return trialRecordSchema.parse({
    meta: {
      schema_version: trialSchemaVersion,
      scenario_id: "math_quadratic",
      locale: "ja",
      stage: "board",
      trial: 1,
      model: "claude-sonnet-5",
      started_at: "2026-08-17T00:00:00.000Z",
      duration_ms: 12_300,
      prompt_sha256: promptSha256("system"),
      ...overrides.meta,
    },
    system_prompt: "system",
    turns: [],
    envelopes: [],
    rejections: [],
    ...overrides,
  });
}

const stepTurn = (overrides: Partial<BoardStep> = {}) =>
  ({ kind: "step", step: step(overrides) }) as const;

describe("scoreTrial", () => {
  it("手順がゼロなら none で、比率は0(0除算にしない)", () => {
    const metrics = scoreTrial(record());
    expect(metrics.steps_total).toBe(0);
    expect(metrics.last_step).toBe("none");
    expect(metrics.board_null_ratio).toBe(0);
    expect(metrics.speech_len_max).toBe(0);
    expect(metrics.speech_len_mean).toBe(0);
    expect(metrics.tex_len_max).toBe(0);
    expect(metrics.wrote_on_board).toBe(false);
    expect(metrics.duration_ms).toBe(12_300);
  });

  it("board:null の比率と wrote_on_board は別物", () => {
    const metrics = scoreTrial(
      record({
        turns: [
          stepTurn({ index: 0, board: null }),
          stepTurn({ index: 1, board: null }),
          stepTurn({ index: 2 }),
        ],
      }),
    );
    expect(metrics.board_null_ratio).toBeCloseTo(2 / 3);
    // 1行でも板書に載っていれば「教えた」側。
    expect(metrics.wrote_on_board).toBe(true);
  });

  it("音声だけの授業は wrote_on_board が偽(見出しだけの白い黒板)", () => {
    const metrics = scoreTrial(record({ turns: [stepTurn({ board: null })] }));
    expect(metrics.wrote_on_board).toBe(false);
    expect(metrics.board_null_ratio).toBe(1);
  });

  it("speech の長さは上限(120)ではなく100字で数える", () => {
    const metrics = scoreTrial(
      record({
        turns: [
          stepTurn({ index: 0, speech: "あ".repeat(speechNearLimit) }),
          stepTurn({ index: 1, speech: "あ".repeat(speechNearLimit + 1) }),
        ],
      }),
    );
    expect(metrics.speech_near_limit).toBe(1);
    expect(metrics.speech_len_max).toBe(speechNearLimit + 1);
    expect(metrics.speech_len_mean).toBe(100.5);
  });

  it("tex は60字超を数える(長い式を割る約束のコード側の相手)", () => {
    const long = `x^{2} + ${"1 + ".repeat(20)}1 = 0`;
    expect(long.length).toBeGreaterThan(texOverLength);
    const metrics = scoreTrial(
      record({
        turns: [
          stepTurn({ index: 0, board: { kind: "latex", tex: long } }),
          stepTurn({ index: 1, board: { kind: "latex", tex: "x = 2" } }),
          // latex 以外(text / figure)は分母にも分子にも入らない。
          stepTurn({ index: 2, board: { kind: "text", body: "ここまでが前半" } }),
        ],
      }),
    );
    expect(metrics.tex_over_60).toBe(1);
    expect(metrics.tex_len_max).toBe(long.length);
  });

  it("awaits_student は申告と推測を分けて数える", () => {
    const metrics = scoreTrial(
      record({
        turns: [
          stepTurn({ index: 0, speech: "まず何する?", awaits_student: true }),
          // 欄が無いが言い回しでは番を渡している = フォールバックで拾った手順。
          stepTurn({ index: 1, speech: "最初の一手、言ってみて。" }),
          // 修辞疑問を false と申告した手順は、どちらにも数えない。
          stepTurn({ index: 2, speech: "じゃあ(1)からやろっか?", awaits_student: false }),
        ],
      }),
    );
    expect(metrics.awaits_declared).toBe(1);
    expect(metrics.awaits_inferred_only).toBe(1);
  });

  it("最終手順で終わり方を3つに分ける", () => {
    const teachBack = scoreTrial(
      record({ turns: [stepTurn({ speech: "じゃあ今の、自分の言葉で説明してみて。" })] }),
    );
    expect(teachBack.last_step).toBe("teach_back");

    const awaiting = scoreTrial(
      record({ turns: [stepTurn({ speech: "ここ、何になると思う?", awaits_student: true })] }),
    );
    expect(awaiting.last_step).toBe("awaits_student");

    // 言い切って終わった = 渡し忘れ。`teachBackFallback` が受け止める側。
    const neither = scoreTrial(record({ turns: [stepTurn({ speech: "これで答えが出たね。" })] }));
    expect(neither.last_step).toBe("neither");
  });

  it("落ちた手順は理由ごとに数える", () => {
    const metrics = scoreTrial(
      record({
        rejections: [
          {
            index: 1,
            kind: "latex",
            reason: "unsupported_command",
            detail: "d",
            guidance: "g",
            raw: {},
          },
          {
            index: 2,
            kind: "latex",
            reason: "unsupported_command",
            detail: "d",
            guidance: "g",
            raw: {},
          },
          { index: 3, kind: "schema", reason: "schema", detail: "d", guidance: "g", raw: {} },
        ],
      }),
    );
    expect(metrics.rejections_total).toBe(3);
    expect(metrics.rejections_by_reason).toEqual({ unsupported_command: 2, schema: 1 });
  });

  it("ok は例外だけでなく配送の error でも偽になる", () => {
    expect(scoreTrial(record()).ok).toBe(true);
    expect(scoreTrial(record({ error: "429" })).ok).toBe(false);
    expect(
      scoreTrial(record({ loop: { reason: "error", passes: 1, step_count: 2, opened: true } })).ok,
    ).toBe(false);
    expect(
      scoreTrial(
        record({ loop: { reason: "handed_over", passes: 2, step_count: 6, opened: true } }),
      ).ok,
    ).toBe(true);
  });

  it("時刻の計測は meta から metrics へ写す(再計算しても消えない)", () => {
    const metrics = scoreTrial(
      record({ meta: { ...record().meta, time_to_first_step_ms: 1_800 } }),
    );
    expect(metrics.time_to_first_step_ms).toBe(1_800);
    expect(scoreTrial(record()).time_to_first_step_ms).toBeUndefined();
  });

  it("L2の指標は stage=loop のときだけ出す", () => {
    const board = scoreTrial(
      record({ loop: { reason: "completed", passes: 1, step_count: 1, opened: true } }),
    );
    expect(board.loop_reason).toBeUndefined();
    expect(board.student_turns).toBeUndefined();

    const loop = scoreTrial(
      record({
        meta: { ...record().meta, stage: "loop", persona: "stuck" },
        turns: [
          stepTurn({ index: 0, speech: "何になると思う?", awaits_student: true }),
          { kind: "student", text: "えっと、12?" },
          { kind: "student", text: studentSilenceMarker("ja") },
          stepTurn({ index: 1, speech: "じゃあ今の、自分の言葉で説明してみて。" }),
        ],
        loop: { reason: "handed_over", passes: 2, step_count: 2, opened: true },
        teach_back: {
          messages: [
            { role: "senpai", text: "うん、それで?" },
            { role: "student", text: "かけて6になる2つを探す" },
          ],
          closed_by_pattern: true,
        },
        karte: { holes: [{ topic_id: "M1-NIJI-HANBETSU" }], said_well: ["因数分解の手順"] },
      }),
    );
    expect(loop.loop_reason).toBe("handed_over");
    expect(loop.passes).toBe(2);
    // 無言の記録は生徒の発話に数えない(transcript にも入らないもの)。
    expect(loop.student_turns).toBe(1);
    expect(loop.silence_markers).toBe(1);
    expect(loop.teach_back_turns).toBe(2);
    expect(loop.teach_back_closed).toBe(true);
    expect(loop.karte_holes).toBe(1);
    expect(loop.karte_said_well).toBe(1);
  });

  it("形の違うカルテは数えない(契約を二重に検査しない)", () => {
    const metrics = scoreTrial(record({ meta: { ...record().meta, stage: "loop" }, karte: {} }));
    expect(metrics.karte_holes).toBeUndefined();
    expect(metrics.karte_said_well).toBeUndefined();
  });
});
