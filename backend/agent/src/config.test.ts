import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { cartesiaTtsModels, elevenLabsTtsModels, geminiLiveTtsModels } from "./senpai-voice.ts";

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

describe("TTS_ENGINE", () => {
  it("既定は gemini(読み上げに後訓練されたモデル)", () => {
    expect(loadConfig(complete).TTS_ENGINE).toBe("gemini");
    expect(loadConfig({ ...complete, TTS_ENGINE: "" }).TTS_ENGINE).toBe("gemini");
  });

  it("gemini-live へは環境変数1つで切り替わる", () => {
    const config = loadConfig({ ...complete, TTS_ENGINE: "gemini-live" });
    expect(config.TTS_ENGINE).toBe("gemini-live");
    expect(config.GEMINI_LIVE_TTS_MODEL).toBe("gemini-2.5-flash-native-audio-preview-12-2025");
  });

  // 綴り間違いで黙って `gemini` に落ちると、live を入れたつもりで比較してしまう。
  it("知らない値は起動時に落とす", () => {
    expect(() => loadConfig({ ...complete, TTS_ENGINE: "live" })).toThrow(/TTS_ENGINE/);
  });

  // 改名前の名前が secret に残ったままだと、TTS_ENGINE 未設定=gemini に落ちて
  // 「Liveにしたつもりの環境が黙って戻る」。音を聞くまで気づけないので落とす。
  it("旧名 GEMINI_TTS_ENGINE が残っていたら落とす", () => {
    expect(() => loadConfig({ ...complete, GEMINI_TTS_ENGINE: "live" })).toThrow(
      /GEMINI_TTS_ENGINE.*TTS_ENGINE へ改名/s,
    );
  });

  it("live のモデルは実在するIDである", () => {
    expect(geminiLiveTtsModels).toContain(loadConfig(complete).GEMINI_LIVE_TTS_MODEL);
  });
});

describe("GEMINI_LIVE_TTS_MODEL", () => {
  // 3.1 へは環境変数1つで行く。音声出力の単価は 2.5 と同じで、text入力だけ5割高い。
  it("3.1 Flash Live へ切り替えられる", () => {
    const config = loadConfig({
      ...complete,
      TTS_ENGINE: "gemini-live",
      GEMINI_LIVE_TTS_MODEL: "gemini-3.1-flash-live-preview",
    });
    expect(config.GEMINI_LIVE_TTS_MODEL).toBe("gemini-3.1-flash-live-preview");
    expect(geminiLiveTtsModels).toContain(config.GEMINI_LIVE_TTS_MODEL);
  });
});

describe("ElevenLabs", () => {
  const withElevenLabs = {
    ...complete,
    TTS_ENGINE: "elevenlabs",
    ELEVENLABS_API_KEY: "key",
    ELEVENLABS_VOICE_ID: "voice",
  };

  it("既定モデルは日英を1つで喋れる版(英語のみの eleven_flash_v2 ではない)", () => {
    const config = loadConfig(withElevenLabs);
    expect(config.ELEVENLABS_MODEL).toBe("eleven_flash_v2_5");
    expect(elevenLabsTtsModels).toContain(config.ELEVENLABS_MODEL);
  });

  // 鍵や声IDの入れ忘れは、無いと分かるのが「最初に喋る瞬間」になる。
  it("engineがelevenlabsのとき、鍵と声IDが無ければ名前を出して落とす", () => {
    expect(() => loadConfig({ ...withElevenLabs, ELEVENLABS_API_KEY: undefined })).toThrow(
      /ELEVENLABS_API_KEY/,
    );
    expect(() => loadConfig({ ...withElevenLabs, ELEVENLABS_VOICE_ID: undefined })).toThrow(
      /ELEVENLABS_VOICE_ID/,
    );
    // `KEY=` は空文字になる。「入っているが空」を通すと同じ壊れ方をする。
    expect(() => loadConfig({ ...withElevenLabs, ELEVENLABS_API_KEY: "" })).toThrow(
      /ELEVENLABS_API_KEY/,
    );
  });

  // 使っていない環境に鍵を置かせない。engineを切り替えたときだけ必須になる。
  it("engineがelevenlabsでなければ、鍵も声IDも要らない", () => {
    expect(loadConfig(complete).ELEVENLABS_API_KEY).toBeUndefined();
    expect(
      loadConfig({ ...complete, TTS_ENGINE: "gemini-live" }).ELEVENLABS_VOICE_ID,
    ).toBeUndefined();
  });
});

describe("Cartesia", () => {
  const withCartesia = {
    ...complete,
    TTS_ENGINE: "cartesia",
    CARTESIA_API_KEY: "key",
    CARTESIA_VOICE_ID: "voice",
  };

  it("既定モデルはプラグイン既定と同じ安定版で、実在するIDである", () => {
    const config = loadConfig(withCartesia);
    expect(config.CARTESIA_TTS_MODEL).toBe("sonic-3");
    expect(cartesiaTtsModels).toContain(config.CARTESIA_TTS_MODEL);
  });

  // 3.5(公称 sub-90ms)へは環境変数1つで行く(Gemini 2.5/3.1 と同じ扱い)。
  it("モデルは環境変数1つで 3.5 へ切り替えられる", () => {
    const config = loadConfig({ ...withCartesia, CARTESIA_TTS_MODEL: "sonic-3.5" });
    expect(config.CARTESIA_TTS_MODEL).toBe("sonic-3.5");
    expect(cartesiaTtsModels).toContain(config.CARTESIA_TTS_MODEL);
  });

  // 鍵や声IDの入れ忘れは、無いと分かるのが「最初に喋る瞬間」になる。
  it("engineがcartesiaのとき、鍵と声IDが無ければ名前を出して落とす", () => {
    expect(() => loadConfig({ ...withCartesia, CARTESIA_API_KEY: undefined })).toThrow(
      /CARTESIA_API_KEY/,
    );
    expect(() => loadConfig({ ...withCartesia, CARTESIA_VOICE_ID: undefined })).toThrow(
      /CARTESIA_VOICE_ID/,
    );
    // `KEY=` は空文字になる。「入っているが空」を通すと同じ壊れ方をする。
    expect(() => loadConfig({ ...withCartesia, CARTESIA_API_KEY: "" })).toThrow(/CARTESIA_API_KEY/);
  });

  // 使っていない環境に鍵を置かせない。engineを切り替えたときだけ必須になる。
  it("engineがcartesiaでなければ、鍵も声IDも要らない", () => {
    expect(loadConfig(complete).CARTESIA_API_KEY).toBeUndefined();
    expect(
      loadConfig({ ...complete, TTS_ENGINE: "gemini-live" }).CARTESIA_VOICE_ID,
    ).toBeUndefined();
  });
});
