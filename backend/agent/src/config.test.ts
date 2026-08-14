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
    expect(config.LLM_MODEL_BOARD).toBe("claude-sonnet-5");
  });

  // The 8/16 gate measures board quality, not conversation speed (plan §3-4).
  // Falling back to the same light model as conversation loses before the gate is tried.
  it("板書は会話より重いモデルを既定にする", () => {
    const config = loadConfig(complete);
    expect(config.LLM_MODEL_BOARD).not.toBe(config.LLM_MODEL_CONVERSATION);
  });

  // The senpai's voice must not vary by environment, so unlike keys it is not required
  it("先輩の声は設定が無くても固定される", () => {
    const config = loadConfig(complete);
    expect(config.DEEPGRAM_TTS_MODEL_JA).toBe("aura-2-izanami-ja");
    expect(config.DEEPGRAM_TTS_MODEL_EN).toBe("aura-2-andromeda-en");
  });

  it("声は聴き比べのために上書きできる", () => {
    const config = loadConfig({ ...complete, DEEPGRAM_TTS_MODEL_JA: "aura-2-other-ja" });
    expect(config.DEEPGRAM_TTS_MODEL_JA).toBe("aura-2-other-ja");
  });

  // Writing `KEY=` in `.env` gives an empty string, not undefined. Passing it through
  // sends an empty model name to the API: startup succeeds but no voice comes out.
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

  // Discovering a missing key mid-conversation is the worst case, so fail at startup
  it("鍵が足りなければ起動時に落とす", () => {
    const { DEEPGRAM_API_KEY, ...missing } = complete;
    expect(() => loadConfig(missing)).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("API_BASE_URLがURLでなければ落とす", () => {
    expect(() => loadConfig({ ...complete, API_BASE_URL: "localhost" })).toThrow();
  });

  // A URL with the scheme dropped makes the framework's new URL() throw, but that
  // exception is swallowed into "closing worker due to error." Name it earlier.
  it("LIVEKIT_URLがURLとして読めなければ、名前を出して落とす", () => {
    expect(() => loadConfig({ ...complete, LIVEKIT_URL: "example.livekit.cloud" })).toThrow(
      /LIVEKIT_URL/,
    );
  });

  // "Missing" and "malformed" need different fixes, so print the reason too
  it("落ちる理由がメッセージに出る", () => {
    expect(() => loadConfig({ ...complete, LIVEKIT_URL: "example.livekit.cloud" })).toThrow(
      /URLとして読めません/,
    );
  });
});
