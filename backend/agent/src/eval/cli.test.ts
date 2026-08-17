import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, stamp, summarize } from "./cli.ts";
import { evalScenarios, scenarioKey } from "./scenario.ts";
import { type TrialRecord, promptSha256, saveTrial, trialSchemaVersion } from "./trial.ts";

/**
 * CLI のテスト。**実LLMを呼ばない。**
 *
 * `run` の検証(stage / locale / trials / シナリオ名)は**鍵を読む前**に置いてあるので、
 * ここで叩くどの引数もネットワークに到達しない。順番を入れ替えると、鍵が入っている
 * 環境でこのテストが実LLMを呼びはじめる。
 */

let out: { log: string[]; error: string[] };

beforeEach(() => {
  out = { log: [], error: [] };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.log.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out.error.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("eval list", () => {
  it("シナリオを全部出す(問題があればその行に印がつく)", async () => {
    expect(await main(["list"])).toBe(0);
    const printed = out.log.join("\n");
    for (const scenario of evalScenarios) {
      expect(printed).toContain(scenarioKey(scenario));
      expect(printed).toContain(scenario.description);
    }
    // 組み込みシナリオは全部通っているので、印は1つも出ない。
    expect(printed).not.toContain("  ! ");
  });
});

describe("コマンドの入口", () => {
  it("コマンド無し・不明なコマンドは使い方を出して1", async () => {
    expect(await main([])).toBe(1);
    expect(out.error.join("\n")).toContain("使い方");
    expect(await main(["nope"])).toBe(1);
    expect(out.error.join("\n")).toContain("不明なコマンド: nope");
  });

  it("知らないオプションは使い方を出して1", async () => {
    expect(await main(["list", "--nope"])).toBe(1);
    expect(out.error.join("\n")).toContain("使い方");
  });

  it("judge は Stage B 未実装", async () => {
    expect(await main(["judge", "eval-out/x"])).toBe(1);
    expect(out.error.join("\n")).toContain("Stage B");
  });
});

describe("eval run の引数(鍵を読む前に落ちる経路)", () => {
  it("--stage loop は Stage C 未実装", async () => {
    expect(await main(["run", "--stage", "loop"])).toBe(1);
    expect(out.error.join("\n")).toContain("Stage C");
  });

  it("知らない stage / locale / trials を弾く", async () => {
    expect(await main(["run", "--stage", "nope"])).toBe(1);
    expect(await main(["run", "--locale", "fr"])).toBe(1);
    expect(await main(["run", "--trials", "0"])).toBe(1);
    expect(await main(["run", "--trials", "1.5"])).toBe(1);
    expect(out.error.join("\n")).toContain("--stage");
    expect(out.error.join("\n")).toContain("--locale");
    expect(out.error.join("\n")).toContain("--trials");
  });

  it("当てはまるシナリオが無ければ、用意してある名前を並べて1", async () => {
    expect(await main(["run", "--scenario", "no_such_scenario"])).toBe(1);
    expect(out.error.join("\n")).toContain("math_quadratic.ja");
  });
});

describe("eval report", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("run ディレクトリが無ければ使い方を出して1", async () => {
    expect(await main(["report"])).toBe(1);
    expect(out.error.join("\n")).toContain("使い方");
  });

  it("試行が無いディレクトリは1", async () => {
    expect(await main(["report", dir])).toBe(1);
    expect(out.error.join("\n")).toContain("試行レコードがありません");
  });

  it("サマリは出すが、比較(Stage B)が無いので1で返す", async () => {
    saveTrial(dir, record());
    expect(await main(["report", dir])).toBe(1);
    expect(out.log.join("\n")).toContain("math_quadratic.ja");
    expect(out.error.join("\n")).toContain("Stage B");
  });
});

describe("summarize", () => {
  it("シナリオごとに1行 + run ディレクトリの行", () => {
    const lines = summarize("/tmp/eval-out/board-1", [
      record({ trial: 1, steps: 8, teachBack: true }),
      record({ trial: 2, steps: 4, teachBack: false, rejections: 2 }),
    ]).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("trials=2");
    expect(lines[0]).toContain("steps=6.0");
    expect(lines[0]).toContain("rejections=2");
    expect(lines[0]).toContain("teach_back=1/2");
    expect(lines[1]).toContain("2 試行");
  });
});

describe("stamp", () => {
  it("ディレクトリ名に使える形にする", () => {
    expect(stamp(new Date("2026-08-17T07:30:00.000Z"))).toBe("20260817-073000");
  });
});

/** サマリの検算用のレコード。指標だけ差し替える。 */
function record(
  input: {
    trial?: number;
    steps?: number;
    teachBack?: boolean;
    rejections?: number;
  } = {},
): TrialRecord {
  const steps = input.steps ?? 3;
  const teachBack = input.teachBack ?? true;
  return {
    meta: {
      schema_version: trialSchemaVersion,
      scenario_id: "math_quadratic",
      locale: "ja",
      stage: "board",
      trial: input.trial ?? 1,
      model: "claude-sonnet-5",
      started_at: "2026-08-17T00:00:00.000Z",
      duration_ms: 10_000,
      prompt_sha256: promptSha256("system"),
    },
    system_prompt: "system",
    turns: [],
    envelopes: [],
    rejections: [],
    metrics: {
      ok: true,
      steps_total: steps,
      rejections_total: input.rejections ?? 0,
      rejections_by_reason: {},
      wrote_on_board: true,
      board_null_ratio: 0,
      speech_len_max: 20,
      speech_len_mean: 14,
      speech_near_limit: 0,
      tex_len_max: 18,
      tex_over_60: 0,
      awaits_declared: 1,
      awaits_inferred_only: 0,
      last_step: teachBack ? "teach_back" : "neither",
      duration_ms: 10_000,
    },
  };
}
