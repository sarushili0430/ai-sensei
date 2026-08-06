import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const complete = {
  API_BASE_URL: "http://localhost:8787",
  INTERNAL_API_TOKEN: "token",
  LIVEKIT_URL: "wss://example.livekit.cloud",
  LIVEKIT_API_KEY: "key",
  LIVEKIT_API_SECRET: "secret",
  ANTHROPIC_API_KEY: "key",
  DEEPGRAM_API_KEY: "key",
};

describe("loadConfig", () => {
  it("モデル名には既定値がある", () => {
    const config = loadConfig(complete);
    expect(config.LLM_MODEL_CONVERSATION).toBe("claude-haiku-4-5-20251001");
    expect(config.LLM_MODEL_KARTE).toBe("claude-sonnet-5");
  });

  // 後輩の声は環境ごとに変わってはいけないので、鍵と違って設定必須にしない
  it("後輩の声は設定が無くても固定される", () => {
    const config = loadConfig(complete);
    expect(config.DEEPGRAM_TTS_MODEL_JA).toBe("aura-2-izanami-ja");
    expect(config.DEEPGRAM_TTS_MODEL_EN).toBe("aura-2-andromeda-en");
  });

  it("声は聴き比べのために上書きできる", () => {
    const config = loadConfig({ ...complete, DEEPGRAM_TTS_MODEL_JA: "aura-2-other-ja" });
    expect(config.DEEPGRAM_TTS_MODEL_JA).toBe("aura-2-other-ja");
  });

  // `.env` に `KEY=` と書くと値は undefined ではなく空文字になる。
  // 素通しすると空のモデル名がAPIまで流れて、起動は通るのに声だけ出ない。
  it("空文字は未設定として扱い、既定値に倒す", () => {
    const config = loadConfig({
      ...complete,
      DEEPGRAM_TTS_MODEL_JA: "",
      DEEPGRAM_TTS_MODEL_EN: "   ",
      LLM_MODEL_KARTE: "",
    });

    expect(config.DEEPGRAM_TTS_MODEL_JA).toBe("aura-2-izanami-ja");
    expect(config.DEEPGRAM_TTS_MODEL_EN).toBe("aura-2-andromeda-en");
    expect(config.LLM_MODEL_KARTE).toBe("claude-sonnet-5");
  });

  // 会話の途中で鍵が無いことに気づくのが最悪なので、起動時に落とす
  it("鍵が足りなければ起動時に落とす", () => {
    const { DEEPGRAM_API_KEY, ...missing } = complete;
    expect(() => loadConfig(missing)).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("API_BASE_URLがURLでなければ落とす", () => {
    expect(() => loadConfig({ ...complete, API_BASE_URL: "localhost" })).toThrow();
  });
});
