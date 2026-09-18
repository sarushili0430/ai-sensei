import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TrialRecord,
  loadTrials,
  promptSha256,
  readRunManifest,
  readTrial,
  runManifestFileName,
  saveRunManifest,
  saveTrial,
  trialExists,
  trialFileName,
  trialPath,
  trialSchemaVersion,
} from "./trial.ts";

/**
 * 試行レコードのテスト。**実LLMもネットワークも使わない。**
 *
 * 見たいのは3つ:
 *   1. 保存の前に検証していること(壊れたレコードを残さない)
 *   2. ファイル名だけで再開の判定ができること
 *   3. `run.json` が再開で**上書きされない**こと(前回のsha256を失わない)
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-trial-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    meta: {
      schema_version: trialSchemaVersion,
      scenario_id: "math_quadratic",
      locale: "ja",
      stage: "board",
      trial: 1,
      model: "claude-sonnet-5",
      started_at: "2026-08-17T00:00:00.000Z",
      duration_ms: 1234,
      prompt_sha256: promptSha256("先輩の板書プロンプト"),
      ...overrides.meta,
    },
    system_prompt: "先輩の板書プロンプト",
    turns: [
      {
        kind: "step",
        step: {
          index: 0,
          speech: "まず、式をそのまま書くね。",
          board: { kind: "latex", tex: "x^2 = 4" },
        },
      },
    ],
    envelopes: [{ v: 1, session_id: "ses_eval", seq: 0, type: "board_step" }],
    rejections: [],
    ...overrides,
  };
}

describe("promptSha256", () => {
  it("同じ本文は同じ札・違う本文は違う札(64桁)", () => {
    const a = promptSha256("同じ本文");
    expect(a).toHaveLength(64);
    expect(a).toBe(promptSha256("同じ本文"));
    expect(a).not.toBe(promptSha256("同じ本文。"));
  });
});

describe("saveTrial / readTrial", () => {
  it("<id>.<locale>.t<N>.json に書いて、そのまま読み返せる", () => {
    const path = saveTrial(dir, record());
    expect(path).toBe(trialPath(dir, { scenario_id: "math_quadratic", locale: "ja", trial: 1 }));
    expect(trialFileName({ scenario_id: "math_quadratic", locale: "ja", trial: 1 })).toBe(
      "math_quadratic.ja.t1.json",
    );
    expect(readTrial(path)).toEqual(record());
  });

  it("契約から外れたレコードは保存の前に落ちる", () => {
    // `speech` は120字まで(`boardSpeechMaxLength`)。壊れたまま残すと、
    // 集計の側からは「板書が出た試行」に見えてしまう。
    const broken = record({
      turns: [{ kind: "step", step: { index: 0, speech: "あ".repeat(200), board: null } }],
    });
    expect(() => saveTrial(dir, broken)).toThrow();
  });

  it("エラーで落ちた部分レコードも保存できる(一次資料として残す)", () => {
    const path = saveTrial(dir, record({ turns: [], error: "板書の生成に失敗しました: 429" }));
    expect(readTrial(path).error).toContain("429");
  });
});

describe("trialExists", () => {
  it("ファイルの有無だけで再開を決める", () => {
    const at = { scenario_id: "math_quadratic", locale: "ja", trial: 2 };
    expect(trialExists(dir, at)).toBe(false);
    saveTrial(dir, record({ meta: { ...record().meta, trial: 2 } }));
    expect(trialExists(dir, at)).toBe(true);
    // 別の試行番号は別のファイル。
    expect(trialExists(dir, { ...at, trial: 3 })).toBe(false);
  });
});

describe("loadTrials", () => {
  it("run.json を混ぜず、名前順に読む", () => {
    saveTrial(dir, record({ meta: { ...record().meta, trial: 2 } }));
    saveTrial(dir, record());
    saveRunManifest(dir, {
      stage: "board",
      created_at: "2026-08-17T00:00:00.000Z",
      model: "claude-sonnet-5",
      argv: ["run"],
      prompt_sha256: {},
    });

    const loaded = loadTrials(dir);
    expect(loaded.map((entry) => entry.meta.trial)).toEqual([1, 2]);
  });

  it("無いディレクトリは空(まだ1本も走っていない run)", () => {
    expect(loadTrials(join(dir, "not-yet"))).toEqual([]);
  });

  it("読めないファイルは名前を出して落ちる(黙って分母から外さない)", () => {
    writeFileSync(join(dir, "broken.ja.t1.json"), "{ではない", "utf8");
    expect(() => loadTrials(dir)).toThrow(/broken\.ja\.t1\.json/);
  });
});

describe("saveRunManifest", () => {
  const base = {
    stage: "board" as const,
    created_at: "2026-08-17T00:00:00.000Z",
    model: "claude-sonnet-5",
    argv: ["run", "--scenario", "math_quadratic"],
    prompt_sha256: { "math_quadratic.ja": promptSha256("A") },
  };

  it("run.json を書いて読み返せる", () => {
    const saved = saveRunManifest(dir, base);
    expect(saved.schema_version).toBe(trialSchemaVersion);
    expect(readRunManifest(dir)).toEqual(saved);
    expect(readTrialNames(dir)).not.toContain(runManifestFileName);
  });

  it("再開しても created_at と前回の sha256 を失わない", () => {
    saveRunManifest(dir, base);
    const merged = saveRunManifest(dir, {
      ...base,
      created_at: "2026-08-18T00:00:00.000Z",
      argv: ["run", "--scenario", "math_figure"],
      prompt_sha256: { "math_figure.ja": promptSha256("B") },
    });

    expect(merged.created_at).toBe(base.created_at);
    expect(merged.argv).toEqual(["run", "--scenario", "math_figure"]);
    expect(Object.keys(merged.prompt_sha256).sort()).toEqual([
      "math_figure.ja",
      "math_quadratic.ja",
    ]);
  });

  it("無い run.json は undefined", () => {
    expect(readRunManifest(dir)).toBeUndefined();
  });
});

/** `loadTrials` が見ているファイル名(run.json を除いた並び)。 */
function readTrialNames(runDir: string): string[] {
  return loadTrials(runDir).map((entry) => trialFileName(entry.meta));
}
