import { describe, expect, it } from "vitest";
import { EvalEnvError, evalEnvDefaults, loadEvalEnv } from "./env.ts";

/**
 * env のテスト。見たいのは2つだけ:
 *
 *   1. **鍵1本で足りること**(`loadConfig()` のように LiveKit まで要求しない)
 *   2. **空文字が既定値に落ちること**(`.env` の `KEY=` は undefined ではない)
 */

describe("loadEvalEnv", () => {
  it("鍵だけで読める(LiveKit や Deepgram の鍵を要求しない)", () => {
    const env = loadEvalEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(env.apiKey).toBe("sk-test");
    expect(env.boardModel).toBe(evalEnvDefaults.boardModel);
    expect(env.judgeModel).toBe(evalEnvDefaults.judgeModel);
    expect(env.studentModel).toBe(evalEnvDefaults.studentModel);
    expect(env.karteModel).toBe(evalEnvDefaults.karteModel);
    expect(env.baseUrl).toBeUndefined();
  });

  it("板書モデルの既定は本番(config.ts の LLM_MODEL_BOARD)と同じ値", () => {
    // 既定がずれると「プロンプトを直したのに数字が動いた」の原因が
    // モデル差か文面差か切り分けられなくなる。
    expect(evalEnvDefaults.boardModel).toBe("claude-sonnet-5");
    expect(evalEnvDefaults.karteModel).toBe("claude-sonnet-5");
  });

  it("空文字と空白は未設定として既定値に落ちる", () => {
    const env = loadEvalEnv({
      ANTHROPIC_API_KEY: "sk-test",
      EVAL_MODEL_BOARD: "",
      EVAL_MODEL_JUDGE: "   ",
      EVAL_ANTHROPIC_BASE_URL: "",
    });
    expect(env.boardModel).toBe(evalEnvDefaults.boardModel);
    expect(env.judgeModel).toBe(evalEnvDefaults.judgeModel);
    expect(env.baseUrl).toBeUndefined();
  });

  it("上書きした値は前後の空白を落として使う", () => {
    const env = loadEvalEnv({
      ANTHROPIC_API_KEY: " sk-test ",
      EVAL_MODEL_BOARD: "claude-opus-5 ",
      EVAL_ANTHROPIC_BASE_URL: "https://example.test",
    });
    expect(env.apiKey).toBe("sk-test");
    expect(env.boardModel).toBe("claude-opus-5");
    expect(env.baseUrl).toBe("https://example.test");
  });

  it("鍵が無ければ日本語で落とす", () => {
    expect(() => loadEvalEnv({})).toThrow(EvalEnvError);
    expect(() => loadEvalEnv({ ANTHROPIC_API_KEY: " " })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
