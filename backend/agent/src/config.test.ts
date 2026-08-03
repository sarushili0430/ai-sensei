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
  ELEVENLABS_API_KEY: "key",
  ELEVENLABS_VOICE_ID: "voice",
};

describe("loadConfig", () => {
  it("モデル名には既定値がある", () => {
    const config = loadConfig(complete);
    expect(config.LLM_MODEL_CONVERSATION).toBe("claude-haiku-4-5-20251001");
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
