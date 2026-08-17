import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardStep } from "@ai-sensei/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmClient } from "../karte.ts";
import {
  countVerdicts,
  detectorMismatches,
  hasJudgeableKarte,
  judgeRun,
  judgeSystemPrompt,
  judgeTrial,
  judgeUserMessage,
  normalizeVerdict,
  readTrialJudge,
} from "./judge.ts";
import { type RubricId, rubricIds } from "./rubrics.ts";
import { type EvalScenario, findScenario } from "./scenario.ts";
import {
  type TrialRecord,
  promptSha256,
  readTrial,
  saveTrial,
  trialPath,
  trialRecordSchema,
  trialSchemaVersion,
} from "./trial.ts";

/**
 * ジャッジのテスト。**実ネットワークを使わない**(固定JSONを返す stub `LlmClient`)。
 *
 * 見たいのは5つ:
 *   1. 判定できないルールは**モデルに聞かず**こちらで `not_applicable` にすること
 *   2. 読めない応答が1回の聞き直しを経て `error` になり、fail に混ざらないこと
 *   3. `asksForTeachBack()` との食い違いが両方向で残ること
 *   4. ジャッジのプロンプトに**先輩へ渡したプロンプト本文と指標を混ぜない**こと
 *   5. `judgeRun` が試行のJSONへ書き戻し、**判定済みを飛ばして再開できる**こと
 */

const scenario = findScenario("math_quadratic", "ja") as EvalScenario;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-judge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const step = (overrides: Partial<BoardStep> = {}): BoardStep => ({
  index: 0,
  speech: "ここ、見てほしいんだけど。",
  board: { kind: "latex", tex: "x^2 = 4" },
  ...overrides,
});

const stepTurn = (overrides: Partial<BoardStep> = {}) =>
  ({ kind: "step", step: step(overrides) }) as const;

function record(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return trialRecordSchema.parse({
    meta: {
      schema_version: trialSchemaVersion,
      scenario_id: scenario.id,
      locale: scenario.locale,
      stage: "board",
      trial: 1,
      model: "claude-sonnet-5",
      started_at: "2026-08-17T00:00:00.000Z",
      duration_ms: 12_300,
      prompt_sha256: promptSha256("先輩の板書プロンプト(ここが判定に混ざってはいけない)"),
      ...overrides.meta,
    },
    system_prompt: "先輩の板書プロンプト(ここが判定に混ざってはいけない)",
    turns: [
      stepTurn({ index: 0, speech: "まず、式をそのまま書くね。" }),
      stepTurn({ index: 1, speech: "じゃあ今の、自分の言葉で説明してみて。", board: null }),
    ],
    envelopes: [],
    rejections: [],
    ...overrides,
  });
}

/** 呼ばれた system / user を残す stub。**呼ばれた回数が聞き直しの検出になる。** */
function stubJudge(...outputs: readonly string[]): LlmClient & {
  calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  return {
    calls,
    async complete({ system, user }) {
      calls.push({ system, user });
      return outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? "";
    },
  };
}

/** ジャッジの応答。既定は全ルール pass。 */
function reply(
  input: {
    verdicts?: Partial<Record<RubricId, string>>;
    signals?: readonly string[];
    omit?: readonly RubricId[];
  } = {},
): string {
  const omit = input.omit ?? [];
  return JSON.stringify({
    rules: rubricIds
      .filter((id) => !omit.includes(id))
      .map((id) => ({
        rule_id: id,
        verdict: input.verdicts?.[id] ?? "pass",
        evidence: "「まず、式をそのまま書くね。」",
        reason: "根拠の1文",
      })),
    teach_back_signals: input.signals ?? ["じゃあ今の、自分の言葉で説明してみて。"],
  });
}

const clock = () => new Date("2026-08-17T09:00:00.000Z").getTime();

describe("judgeTrial", () => {
  it("全ルールをルーブリックの順で返し、L1で判定できないものはこちらで not_applicable にする", async () => {
    const llm = stubJudge(reply({ verdicts: { grading_language: "fail" } }));
    const judge = await judgeTrial(record(), {
      llm,
      scenario,
      model: "claude-opus-5",
      now: clock,
    });

    expect(judge.rules.map((rule) => rule.rule_id)).toEqual([...rubricIds]);
    expect(judge.model).toBe("claude-opus-5");
    expect(judge.judged_at).toBe("2026-08-17T09:00:00.000Z");
    expect(judge.error).toBeUndefined();

    const verdictOf = (id: RubricId) => judge.rules.find((rule) => rule.rule_id === id)?.verdict;
    expect(verdictOf("grading_language")).toBe("fail");
    expect(verdictOf("teach_back_handover")).toBe("pass");
    // ジャッジは R1/R7 にも pass を返しているが、**こちらの判定が勝つ。**
    expect(verdictOf("answer_before_student")).toBe("not_applicable");
    expect(verdictOf("karte_grounding")).toBe("not_applicable");
    expect(judge.rules.find((rule) => rule.rule_id === "answer_before_student")?.reason).toContain(
      "生徒の発話が無い",
    );
    expect(countVerdicts(judge)).toEqual({ pass: 4, fail: 1, not_applicable: 2, error: 0 });
  });

  it("L2でカルテがあれば R1 と R7 も判定する", async () => {
    const llm = stubJudge(reply({ verdicts: { answer_before_student: "fail" } }));
    const judge = await judgeTrial(
      record({
        meta: { ...record().meta, stage: "loop", persona: "stuck" },
        turns: [
          stepTurn({ index: 0, speech: "まず何する?", awaits_student: true }),
          { kind: "student", text: "因数分解、かな" },
        ],
        karte: { said_well: ["因数分解の手順"], holes: [] },
      }),
      { llm, scenario, now: clock },
    );

    expect(judge.rules.every((rule) => rule.verdict !== "not_applicable")).toBe(true);
    expect(judge.rules.find((rule) => rule.rule_id === "answer_before_student")?.verdict).toBe(
      "fail",
    );
    // 判定できるルールが増えたぶんだけ、ジャッジに渡すルーブリックも増える。
    expect(llm.calls[0]?.system).toContain("answer_before_student");
    expect(llm.calls[0]?.system).toContain("karte_grounding");
  });

  it("カルテ生成が失敗した試行(karte:{error})のR7は判定しない", async () => {
    // `run-loop.ts` はカルテ生成の失敗を `{error}` で残す(試行ごと捨てないため)。
    // それをR7に掛けると「穴ゼロ」を違反として裁くので、無かったことにする。
    const llm = stubJudge(reply({}));
    const judge = await judgeTrial(
      record({
        meta: { ...record().meta, stage: "loop", persona: "stuck" },
        turns: [
          stepTurn({ index: 0, speech: "まず何する?", awaits_student: true }),
          { kind: "student", text: "因数分解、かな" },
        ],
        karte: { error: "カルテ生成に失敗しました: 429" },
      }),
      { llm, scenario, now: clock },
    );

    expect(judge.rules.find((rule) => rule.rule_id === "karte_grounding")?.verdict).toBe(
      "not_applicable",
    );
    expect(llm.calls[0]?.system).not.toContain("karte_grounding");
  });

  it("hasJudgeableKarte は {error} と空をカルテに数えない", () => {
    expect(hasJudgeableKarte(undefined)).toBe(false);
    expect(hasJudgeableKarte(null)).toBe(false);
    expect(hasJudgeableKarte({ error: "x" })).toBe(false);
    expect(hasJudgeableKarte({ said_well: [], holes: [] })).toBe(true);
  });

  it("大文字や n/a の書き方の揺れで聞き直しを買わない", () => {
    expect(normalizeVerdict("PASS")).toBe("pass");
    expect(normalizeVerdict(" Fail ")).toBe("fail");
    expect(normalizeVerdict("N/A")).toBe("not_applicable");
    expect(normalizeVerdict("not applicable")).toBe("not_applicable");
    // `error` はこちらの札。モデルからは受けない。
    expect(normalizeVerdict("error")).toBeUndefined();
    expect(normalizeVerdict("たぶん大丈夫")).toBeUndefined();
  });

  it("判定の語が読めないルールだけ error にする(ほかは残す)", async () => {
    const llm = stubJudge(reply({ verdicts: { commanding: "だいたい pass" } }));
    const judge = await judgeTrial(record(), { llm, scenario, now: clock });
    const rule = judge.rules.find((entry) => entry.rule_id === "commanding");
    expect(rule?.verdict).toBe("error");
    expect(rule?.reason).toContain("判定の語が読めません");
    expect(judge.rules.find((entry) => entry.rule_id === "topic_scope")?.verdict).toBe("pass");
    expect(judge.error).toBeUndefined();
  });

  it("返ってこなかったルールは error(黙って pass にしない)", async () => {
    const llm = stubJudge(reply({ omit: ["blames_pass"] }));
    const judge = await judgeTrial(record(), { llm, scenario, now: clock });
    const rule = judge.rules.find((entry) => entry.rule_id === "blames_pass");
    expect(rule?.verdict).toBe("error");
    expect(rule?.reason).toContain("返しませんでした");
  });

  it("読めない応答は1回だけ聞き直す(そこで通れば判定として残る)", async () => {
    const llm = stubJudge("JSONではない返事", reply());
    const judge = await judgeTrial(record(), { llm, scenario, now: clock });
    expect(llm.calls).toHaveLength(2);
    // 聞き直しは**同じプロンプト**で投げる(条件を変えると別の測定になる)。
    expect(llm.calls[0]?.user).toBe(llm.calls[1]?.user);
    expect(judge.error).toBeUndefined();
    expect(countVerdicts(judge).error).toBe(0);
  });

  it("2回読めなければ判定できたルールを全部 error にし、突き合わせはしない", async () => {
    const llm = stubJudge("こちらは板書の講評です");
    const judge = await judgeTrial(record(), { llm, scenario, now: clock });

    expect(llm.calls).toHaveLength(2);
    expect(judge.error).toContain("ジャッジの応答が読めませんでした");
    expect(countVerdicts(judge)).toEqual({ pass: 0, fail: 0, not_applicable: 2, error: 5 });
    // 引用がゼロなのは「合図が無かった」ではなく「聞けていない」。
    // ここで計算すると、本物の合図が全部 detector_only に化ける。
    expect(judge.detector_mismatches).toEqual([]);
    expect(judge.teach_back_signals).toEqual([]);
  });

  it("引用と検出器が一致していれば食い違いを出さない", async () => {
    const llm = stubJudge(reply({ signals: ["じゃあ今の、自分の言葉で説明してみて。"] }));
    const judge = await judgeTrial(record(), { llm, scenario, now: clock });
    expect(judge.detector_mismatches).toEqual([]);
  });
});

describe("detectorMismatches", () => {
  it("ジャッジだけが合図と読んだ発話(取りこぼし側)を残す", () => {
    // 「一言でいいよ」で終わる問いかけは `asksForTeachBack` の族に無い。
    const target = record({
      turns: [stepTurn({ index: 0, speech: "まず何する? 一言でいいよ。", board: null })],
    });
    const mismatches = detectorMismatches(target, ["まず何する? 一言でいいよ。"]);
    expect(mismatches).toEqual([
      { direction: "judge_only", speech: "まず何する? 一言でいいよ。", step_index: 0 },
    ]);
  });

  it("検出器だけが合図と見た手順(拾いすぎ側)を残す", () => {
    const mismatches = detectorMismatches(record(), ["まず、式をそのまま書くね。"]);
    // 引用した1手順は合図ではない → judge_only、挙げられなかった受け渡しは detector_only。
    expect(mismatches.map((mismatch) => mismatch.direction)).toEqual([
      "judge_only",
      "detector_only",
    ]);
    expect(mismatches[1]?.speech).toContain("自分の言葉で説明してみて");
    expect(mismatches[1]?.step_index).toBe(1);
  });

  it("手順に結びつかない引用は step_index を付けずに残す", () => {
    const mismatches = detectorMismatches(
      record({ turns: [stepTurn({ index: 0, speech: "まず、式をそのまま書くね。" })] }),
      ["先輩が言い換えた別の文"],
    );
    expect(mismatches).toEqual([{ direction: "judge_only", speech: "先輩が言い換えた別の文" }]);
  });

  it("短すぎる引用は手順に当てない(どこにでも当たる)", () => {
    const mismatches = detectorMismatches(record(), ["ね"]);
    expect(mismatches[0]?.step_index).toBeUndefined();
  });
});

describe("ジャッジのプロンプト", () => {
  it("system に改正の告知と、判定するルールの本文だけを入れる", () => {
    const system = judgeSystemPrompt();
    expect(system).toContain("2026-08-09");
    expect(system).toContain("違反ではない");
    expect(system).toContain("teach_back_signals");
    expect(system).toContain('"pass"');
  });

  it("user は入力・記録・教え返し・カルテの順で、記録には通し番号が付く", () => {
    const user = judgeUserMessage(record(), scenario);
    expect(user).toContain("x^2 - 5x + 6 = 0");
    expect(user).toContain("T1 1. 「まず、式をそのまま書くね。」");
    expect(user).toContain("T2 2. 「じゃあ今の、自分の言葉で説明してみて。」");
    expect(user.indexOf("授業の記録")).toBeLessThan(user.indexOf("カルテ"));
    // L1にはどちらも無い。空欄ではなく「無い」と書く(prompts の定型句と同じ理由)。
    expect(user).toContain("(発話なし)");
    expect(user).toContain("(なし)");
  });

  it("先輩に渡したプロンプト本文と指標は渡さない", () => {
    const target = record({ metrics: undefined });
    const user = judgeUserMessage(target, scenario);
    expect(user).not.toContain("ここが判定に混ざってはいけない");
    expect(user).not.toContain("last_step");
    expect(user).not.toContain("rejections");
  });

  it("L2では教え返しの会話とカルテを貼る(ロール名は transcript と同じ語彙)", () => {
    const user = judgeUserMessage(
      record({
        meta: { ...record().meta, stage: "loop" },
        teach_back: {
          messages: [
            { role: "senpai", text: "うん、それで?" },
            { role: "student", text: "かけて6になる2つを探す" },
          ],
          closed_by_pattern: true,
        },
        karte: { said_well: ["因数分解の手順"], holes: [] },
      }),
      scenario,
    );
    expect(user).toContain("先輩: うん、それで?");
    expect(user).toContain("ユーザー: かけて6になる2つを探す");
    expect(user).toContain('"said_well"');
    expect(user).toContain("授業の往復");
  });
});

describe("judgeRun", () => {
  it("判定を書き戻し、2回目は全部飛ばす(再開できる)", async () => {
    saveTrial(dir, record());
    saveTrial(dir, record({ meta: { ...record().meta, trial: 2 } }));

    const llm = stubJudge(reply());
    const first = await judgeRun(dir, { llm, model: "claude-opus-5", now: clock });
    expect(first.judged).toBe(2);
    expect(first.skipped).toBe(0);
    expect(llm.calls).toHaveLength(2);

    const saved = readTrial(
      trialPath(dir, { scenario_id: scenario.id, locale: scenario.locale, trial: 1 }),
    );
    expect(readTrialJudge(saved)?.model).toBe("claude-opus-5");
    expect(first.records.every((entry) => readTrialJudge(entry) !== undefined)).toBe(true);

    const second = await judgeRun(dir, { llm, now: clock });
    expect(second.judged).toBe(0);
    expect(second.skipped).toBe(2);
    // 判定済みには**もう一度払わない**。
    expect(llm.calls).toHaveLength(2);
  });

  it("ハーネス側の事故と空の記録は判定せず、理由を残す", async () => {
    saveTrial(dir, record({ meta: { ...record().meta, trial: 1 }, error: "429" }));
    saveTrial(dir, record({ meta: { ...record().meta, trial: 2 }, turns: [] }));

    const llm = stubJudge(reply());
    const result = await judgeRun(dir, { llm, now: clock });

    expect(result.judged).toBe(0);
    expect(result.excluded).toBe(2);
    expect(llm.calls).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("ハーネス側の事故");
    expect(result.warnings.join("\n")).toContain("記録が空");
    // 判定しなかった試行も、レポートの分母を数える側へ渡す。
    expect(result.records).toHaveLength(2);
  });

  it("前回が error で終わった判定はもう一度聞く(通信の失敗を成績にしない)", async () => {
    const failing = stubJudge("JSONではない返事");
    saveTrial(dir, record());
    const first = await judgeRun(dir, { llm: failing, now: clock });
    expect(first.judged).toBe(1);
    expect(first.ruleErrors).toBe(5);

    const llm = stubJudge(reply());
    const second = await judgeRun(dir, { llm, now: clock });
    expect(second.judged).toBe(1);
    expect(second.skipped).toBe(0);
    expect(second.ruleErrors).toBe(0);
  });

  it("進捗は1行ずつ渡す(CLIが stderr へ出す形)", async () => {
    saveTrial(dir, record());
    const lines: string[] = [];
    await judgeRun(dir, {
      llm: stubJudge(reply({ verdicts: { topic_scope: "fail" } })),
      now: clock,
      onProgress: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("math_quadratic.ja t1");
    expect(lines[0]).toContain("fail=1");
  });

  it("試行が無い run は何もしない", async () => {
    const result = await judgeRun(join(dir, "not-yet"), { llm: stubJudge(reply()), now: clock });
    expect(result).toMatchObject({ judged: 0, skipped: 0, excluded: 0, records: [] });
  });
});

describe("readTrialJudge", () => {
  it("読めない判定は「無い」として扱う(古いスキーマは判定し直す側へ回る)", () => {
    expect(readTrialJudge(record())).toBeUndefined();
    expect(readTrialJudge(record({ judge: { rules: "こわれている" } }))).toBeUndefined();
  });
});
