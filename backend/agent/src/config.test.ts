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
  GOOGLE_API_KEY: "key",
};

describe("loadConfig", () => {
  it("モデル名には既定値がある", () => {
    const config = loadConfig(complete);
    expect(config.LLM_MODEL_CONVERSATION).toBe("claude-haiku-4-5-20251001");
    expect(config.LLM_MODEL_KARTE).toBe("claude-sonnet-5");
    expect(config.LLM_MODEL_BOARD).toBe("claude-sonnet-5");
  });

  // 8/16のゲートで測られるのは会話の速さではなく板書の質(計画書 §3-4)。
  // 会話と同じ軽いモデルに落ちると、そのゲートを試す前に負ける。
  it("板書は会話より重いモデルを既定にする", () => {
    const config = loadConfig(complete);
    expect(config.LLM_MODEL_BOARD).not.toBe(config.LLM_MODEL_CONVERSATION);
  });

  // 先輩の声は環境ごとに変わってはいけないので、鍵と違って設定必須にしない
  it("先輩の声は設定が無くても固定される", () => {
    const config = loadConfig(complete);
    expect(config.GEMINI_TTS_VOICE).toBe("Leda");
  });

  // 既定は2.5、3.1は入れた人だけが踏む(ADR 0008)。
  it("TTSの既定は 2.5 で、3.1 は環境変数で切り替える", () => {
    expect(loadConfig(complete).GEMINI_TTS_MODEL).toBe("gemini-2.5-flash-preview-tts");

    const next = loadConfig({ ...complete, GEMINI_TTS_MODEL: "gemini-3.1-flash-tts-preview" });
    expect(next.GEMINI_TTS_MODEL).toBe("gemini-3.1-flash-tts-preview");
  });

  it("声は聴き比べのために上書きできる", () => {
    const config = loadConfig({ ...complete, GEMINI_TTS_VOICE: "Aoede" });
    expect(config.GEMINI_TTS_VOICE).toBe("Aoede");
  });

  // `.env` に `KEY=` と書くと値は undefined ではなく空文字になる。
  // 素通しすると空のモデル名がAPIまで流れて、起動は通るのに声だけ出ない。
  it("空文字は未設定として扱い、既定値に倒す", () => {
    const config = loadConfig({
      ...complete,
      GEMINI_TTS_MODEL: "",
      GEMINI_TTS_VOICE: "   ",
      LLM_MODEL_KARTE: "",
    });

    expect(config.GEMINI_TTS_MODEL).toBe("gemini-2.5-flash-preview-tts");
    expect(config.GEMINI_TTS_VOICE).toBe("Leda");
    expect(config.LLM_MODEL_KARTE).toBe("claude-sonnet-5");
  });

  // 会話の途中で鍵が無いことに気づくのが最悪なので、起動時に落とす
  it("鍵が足りなければ起動時に落とす", () => {
    const { DEEPGRAM_API_KEY, ...missing } = complete;
    expect(() => loadConfig(missing)).toThrow(/DEEPGRAM_API_KEY/);
  });

  // 聞く側と喋る側でベンダーが分かれたので、鍵は2本要る(ADR 0008)。
  // 喋る側の鍵だけが無いと、会話は始まるのに先輩が無言のまま終わる。
  it("TTSの鍵が無ければ起動時に落とす", () => {
    const { GOOGLE_API_KEY, ...missing } = complete;
    expect(() => loadConfig(missing)).toThrow(/GOOGLE_API_KEY/);
  });

  it("API_BASE_URLがURLでなければ落とす", () => {
    expect(() => loadConfig({ ...complete, API_BASE_URL: "localhost" })).toThrow();
  });

  // スキームの落ちたURLはフレームワーク側の new URL() が投げるが、その例外は
  // 握り潰されて「closing worker due to error.」としか出ない。手前で名前を出す。
  it("LIVEKIT_URLがURLとして読めなければ、名前を出して落とす", () => {
    expect(() => loadConfig({ ...complete, LIVEKIT_URL: "example.livekit.cloud" })).toThrow(
      /LIVEKIT_URL/,
    );
  });

  // 「足りない」と「形が違う」は直し方が違うので、理由まで出す
  it("落ちる理由がメッセージに出る", () => {
    expect(() => loadConfig({ ...complete, LIVEKIT_URL: "example.livekit.cloud" })).toThrow(
      /URLとして読めません/,
    );
  });
});
