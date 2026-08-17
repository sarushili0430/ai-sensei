import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardStep } from "@ai-sensei/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrialJudge } from "./judge.ts";
import { judgeSchemaVersion } from "./judge.ts";
import { compareRuns, summarizeRun, worseMark } from "./report.ts";
import { type RubricId, rubricIds } from "./rubrics.ts";
import { scoreTrial } from "./score.ts";
import {
  type TrialRecord,
  promptSha256,
  saveRunManifest,
  saveTrial,
  trialRecordSchema,
  trialSchemaVersion,
} from "./trial.ts";

/**
 * レポートのテスト。**Markdown の文字列を組むだけ**なので、LLMもネットワークも要らない。
 *
 * 見たいのは4つ:
 *   1. `error` 付きの試行が分母から外れ、**外したことが脚注に残る**こと
 *   2. ジャッジ未実行の run でも決定的スコアだけで表が出ること
 *   3. 悪化したセルに印が付き、良くなったセルには付かないこと
 *   4. プロンプトの sha256 が同じ2つの run に警告が出ること(比較する意味がない)
 */

let base: string;
let candidate: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "eval-report-base-"));
  candidate = mkdtempSync(join(tmpdir(), "eval-report-cand-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(candidate, { recursive: true, force: true });
});

const step = (overrides: Partial<BoardStep> = {}): BoardStep => ({
  index: 0,
  speech: "まず、式をそのまま書くね。",
  board: { kind: "latex", tex: "x^2 = 4" },
  ...overrides,
});

type TrialInput = {
  trial: number;
  scenario?: string;
  /** 最終手順を教え返しへの受け渡しにするか(`last_step` の材料)。 */
  teachBack?: boolean;
  rejections?: number;
  error?: string;
  prompt?: string;
  model?: string;
  /** L2として保存し、`loop_reason` を持たせる。 */
  loopReason?: "handed_over" | "completed";
  judge?: TrialJudge;
};

/** 指標は `scoreTrial` に数えさせる(レポートが読む値を本物にそろえる)。 */
function trial(input: TrialInput): TrialRecord {
  const prompt = input.prompt ?? "先輩の板書プロンプト A";
  const record = trialRecordSchema.parse({
    meta: {
      schema_version: trialSchemaVersion,
      scenario_id: input.scenario ?? "math_quadratic",
      locale: "ja",
      stage: input.loopReason === undefined ? "board" : "loop",
      trial: input.trial,
      model: input.model ?? "claude-sonnet-5",
      started_at: "2026-08-17T00:00:00.000Z",
      duration_ms: 10_000,
      prompt_sha256: promptSha256(prompt),
    },
    system_prompt: prompt,
    turns: [
      { kind: "step", step: step({ index: 0 }) },
      {
        kind: "step",
        step: step({
          index: 1,
          speech:
            input.teachBack === false
              ? "これで答えが出たね。"
              : "じゃあ今の、自分の言葉で説明してみて。",
          board: null,
        }),
      },
    ],
    envelopes: [],
    rejections: Array.from({ length: input.rejections ?? 0 }, (_, index) => ({
      index: index + 1,
      kind: "latex",
      reason: "unsupported_command",
      detail: "d",
      guidance: "g",
      raw: {},
    })),
    ...(input.loopReason === undefined
      ? {}
      : { loop: { reason: input.loopReason, passes: 2, step_count: 2, opened: true } }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.judge === undefined ? {} : { judge: input.judge }),
  });
  return { ...record, metrics: scoreTrial(record) };
}

/** ジャッジの判定。既定は全ルール pass。 */
function judge(
  input: {
    verdicts?: Partial<Record<RubricId, "pass" | "fail" | "not_applicable" | "error">>;
    mismatches?: TrialJudge["detector_mismatches"];
    error?: string;
  } = {},
): TrialJudge {
  return {
    schema_version: judgeSchemaVersion,
    model: "claude-opus-5",
    judged_at: "2026-08-17T09:00:00.000Z",
    rules: rubricIds.map((id) => ({
      rule_id: id,
      verdict: input.verdicts?.[id] ?? "pass",
      evidence: "",
      reason: "",
    })),
    teach_back_signals: [],
    detector_mismatches: input.mismatches ?? [],
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

describe("summarizeRun", () => {
  it("試行が1本も無い run は、その1行だけを返す(例外にしない)", () => {
    expect(summarizeRun(base)).toContain("試行レコードがありません");
  });

  it("シナリオごとに1行。ハーネス側の事故は分母から外して脚注に残す", () => {
    saveTrial(base, trial({ trial: 1 }));
    saveTrial(base, trial({ trial: 2, teachBack: false, rejections: 2 }));
    saveTrial(base, trial({ trial: 3, error: "board_append_failed: 429" }));
    saveRunManifest(base, {
      stage: "board",
      created_at: "2026-08-17T07:30:00.000Z",
      model: "claude-sonnet-5",
      argv: ["run"],
      prompt_sha256: { "math_quadratic.ja": promptSha256("先輩の板書プロンプト A") },
    });

    const report = summarizeRun(base);
    const row = report.split("\n").find((line) => line.startsWith("| math_quadratic.ja"));

    expect(report).toContain("- 試行: 3 件");
    // 分母は事故を外した2件。教え返しへ渡せたのは1件。
    expect(row).toContain("| 2 |");
    expect(row).toContain("1/2");
    expect(row).toContain("1.0");
    expect(report).toContain("分母から外した試行: 1 件");
    expect(report).toContain("math_quadratic.ja t3");
    expect(report).toContain("2026-08-17T07:30:00.000Z");
  });

  it("ジャッジ未実行でも表は出る(決定的スコアだけで読める)", () => {
    saveTrial(base, trial({ trial: 1 }));
    const report = summarizeRun(base);
    expect(report).toContain("判定がありません");
    // judge の列は `-`。ほかの列は数字が入る。
    expect(report).toContain("| 1/1 | 2.0 |");
    expect(report.split("\n").find((line) => line.startsWith("| math_quadratic.ja"))).toContain(
      "| - |",
    );
  });

  it("ジャッジがあればルール別に集計し、検出器との食い違いを索引として出す", () => {
    saveTrial(
      base,
      trial({
        trial: 1,
        judge: judge({
          verdicts: { grading_language: "fail", answer_before_student: "not_applicable" },
          mismatches: [
            { direction: "judge_only", speech: "まず何する? 一言でいいよ。", step_index: 1 },
            { direction: "detector_only", speech: "じゃあ今の、自分の言葉で説明してみて。" },
          ],
        }),
      }),
    );
    saveTrial(base, trial({ trial: 2, judge: judge({ error: "読めませんでした" }) }));

    const report = summarizeRun(base);
    expect(report).toContain("判定した試行: 2 件");
    expect(report).toContain("R2 `grading_language`");
    expect(report).toContain("R1 `answer_before_student`");
    expect(report).toContain("judge_only 1 件 / detector_only 1 件");
    expect(report).toContain("一言でいいよ");
    // 応答が読めなかった試行は、fail ではなく警告として出す。
    expect(report).toContain("応答が読めなかった試行が 1 件");
    // 2件のうち fail が付いたのは1件。
    expect(report.split("\n").find((line) => line.startsWith("| math_quadratic.ja"))).toContain(
      "1/2",
    );
  });

  it("run の途中でプロンプトが変わっていたら警告する(1つの母数として読めない)", () => {
    saveTrial(base, trial({ trial: 1, prompt: "A" }));
    saveTrial(base, trial({ trial: 2, prompt: "B" }));
    expect(summarizeRun(base)).toContain("run の途中でプロンプトが変わっています");
  });

  it("metrics が無いレコードはその場で数え直す", () => {
    const record = trial({ trial: 1 });
    saveTrial(base, { ...record, metrics: undefined });
    const row = summarizeRun(base)
      .split("\n")
      .find((line) => line.startsWith("| math_quadratic.ja"));
    expect(row).toContain("2.0");
    expect(row).toContain("1/1");
  });

  it("L2の列は L2 の試行だけを分母にする", () => {
    saveTrial(base, trial({ trial: 1, loopReason: "handed_over" }));
    saveTrial(base, trial({ trial: 2, loopReason: "completed" }));
    const row = summarizeRun(base)
      .split("\n")
      .find((line) => line.startsWith("| math_quadratic.ja"));
    expect(row).toContain("1/2");
  });
});

describe("compareRuns", () => {
  it("悪化したセルに印を付け、良くなったセルには付けない", () => {
    saveTrial(base, trial({ trial: 1, teachBack: true, rejections: 2 }));
    saveTrial(candidate, trial({ trial: 1, teachBack: false, rejections: 0, prompt: "B" }));

    const report = compareRuns(base, candidate);
    const row = report.split("\n").find((line) => line.startsWith("| math_quadratic.ja")) ?? "";

    // 教え返しへ渡せなくなった = 悪化。
    expect(row).toContain(`1/1 → 0/1 ${worseMark}`);
    // 落ちた手順は減った = 印を付けない。
    expect(row).toContain("2.0 → 0.0");
    expect(row).not.toContain(`2.0 → 0.0 ${worseMark}`);
    expect(report).toContain(worseMark);
  });

  it("プロンプトの sha256 が同じなら、表より前に警告を出す", () => {
    saveTrial(base, trial({ trial: 1, prompt: "同じプロンプト" }));
    saveTrial(candidate, trial({ trial: 1, prompt: "同じプロンプト" }));

    const report = compareRuns(base, candidate);
    expect(report).toContain("sha256 が同じシナリオがあります");
    expect(report.indexOf("警告")).toBeLessThan(report.indexOf("| シナリオ"));
  });

  it("プロンプトが違えば警告を出さない", () => {
    saveTrial(base, trial({ trial: 1, prompt: "A" }));
    saveTrial(candidate, trial({ trial: 1, prompt: "B" }));
    expect(compareRuns(base, candidate)).not.toContain("sha256 が同じ");
  });

  it("モデルが違う比較は、プロンプトの差ではないと言う", () => {
    saveTrial(base, trial({ trial: 1, prompt: "A" }));
    saveTrial(candidate, trial({ trial: 1, prompt: "B", model: "claude-haiku-4-5-20251001" }));
    expect(compareRuns(base, candidate)).toContain("モデルが違います");
  });

  it("片方にしか無いシナリオは、無い側を `-` にする", () => {
    saveTrial(base, trial({ trial: 1 }));
    saveTrial(candidate, trial({ trial: 1, scenario: "math_figure", prompt: "B" }));

    const report = compareRuns(base, candidate);
    const rows = report.split("\n").filter((line) => line.startsWith("| math_"));
    expect(rows).toHaveLength(2);
    expect(rows.find((line) => line.includes("math_figure"))).toContain("- → 1/1");
    expect(rows.find((line) => line.includes("math_quadratic"))).toContain("1/1 → -");
  });

  it("試行が無い側は警告する(比較が成立していない)", () => {
    saveTrial(base, trial({ trial: 1 }));
    expect(compareRuns(base, candidate)).toContain("cand に試行がありません");
  });

  it("ジャッジ済みの run どうしは judge fail の列で並ぶ", () => {
    saveTrial(base, trial({ trial: 1, judge: judge() }));
    saveTrial(
      candidate,
      trial({ trial: 1, prompt: "B", judge: judge({ verdicts: { commanding: "fail" } }) }),
    );

    const row =
      compareRuns(base, candidate)
        .split("\n")
        .find((line) => line.startsWith("| math_quadratic.ja")) ?? "";
    expect(row).toContain(`0/1 → 1/1 ${worseMark}`);
  });
});
