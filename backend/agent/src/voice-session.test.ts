import { initializeLogger } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import { beforeAll, describe, expect, it } from "vitest";
import { type AgentConfig, loadConfig } from "./config.ts";
import { CachedInstructionsLLM } from "./conversation-llm.ts";
import { GeminiLiveTTS } from "./gemini-live-tts.ts";
import { geminiTtsModels, ttsInstructionsForLocale } from "./senpai-voice.ts";
import {
  createGeminiTts,
  createSenpaiTts,
  createVoiceSession,
  jaSpeakable,
  sentenceTokenizerForLocale,
  ttsTextTransformsForLocale,
} from "./voice-session.ts";

/** 既定値まで通した設定。モデル名を直書きすると config.ts とずれても気づけない。 */
function testConfig(overrides: Record<string, string> = {}): AgentConfig {
  return loadConfig({
    API_BASE_URL: "http://localhost:8787",
    INTERNAL_API_TOKEN: "token",
    LIVEKIT_URL: "wss://example.livekit.cloud",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    ANTHROPIC_API_KEY: "key",
    DEEPGRAM_API_KEY: "key",
    GOOGLE_API_KEY: "key",
    ...overrides,
  });
}

// プラグインのコンストラクタが `log()` を触る(ElevenLabsはインスタンス変数の初期化で
// 呼ぶので `new` した時点)。TTSを組み立てるテストが増えたのでファイル全体で先に入れる。
beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));

function textStream(chunks: readonly string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readText(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

describe("jaSpeakable", () => {
  it("数式記号がチャンク境界をまたいでも一つの式として読む", async () => {
    await expect(readText(jaSpeakable(textStream(["∠", "ABC = 30", "°です。"])))).resolves.toBe(
      "かくエービーシー イコール さんじゅうどです。",
    );
  });
});

describe("ttsTextTransformsForLocale", () => {
  it("日本語だけに読み替えを追加し、既定の変換を保つ", () => {
    const transforms = ttsTextTransformsForLocale("ja");
    expect(transforms.slice(0, 2)).toEqual(["filter_markdown", "filter_emoji"]);
    expect(transforms).toHaveLength(3);
  });

  it("英語ロケールには日本語の読み替えを渡さない", () => {
    expect(ttsTextTransformsForLocale("en")).toEqual(["filter_markdown", "filter_emoji"]);
  });
});

describe("createGeminiTts", () => {
  it("既定は 2.5 で、環境変数1つで 3.1 に替わる", () => {
    expect(createGeminiTts(testConfig(), "ja").opts.model).toBe("gemini-2.5-flash-preview-tts");

    const next = testConfig({ GEMINI_TTS_MODEL: "gemini-3.1-flash-tts-preview" });
    expect(createGeminiTts(next, "ja").opts.model).toBe("gemini-3.1-flash-tts-preview");
  });

  // プラグインの `GeminiTTSModels` 型には `gemini-2.5-flash-tts` のような
  // **存在しない名前**が混じっていて、`model` は string として素通しされる。
  // 型に釣られて書き換えても起動は通り、最初に喋る瞬間に落ちるので、ここで縛る。
  it("既定は実在するモデルIDである", () => {
    const model = createGeminiTts(testConfig(), "ja").opts.model;
    expect(geminiTtsModels).toContain(model);
  });

  // Deepgramは言語がモデル名に埋まっていて日英で別ボイスだった。Geminiは1つの声が
  // 両方を喋るので、ロケールで先輩が別人にならない(ADR 0008)。
  it("先輩の声はロケールで変わらない", () => {
    const config = testConfig();
    expect(createGeminiTts(config, "ja").opts.voiceName).toBe("Leda");
    expect(createGeminiTts(config, "en").opts.voiceName).toBe(
      createGeminiTts(config, "ja").opts.voiceName,
    );
  });
});

describe("ttsInstructionsForLocale", () => {
  // 読ませているのは授業の本文で、生成モデルは問いかけに答えてしまえる。
  // 板書と声がずれた瞬間に授業が成立しないので、どのロケールでも必ず釘を刺す。
  it("省略・追加・翻訳・返答をどのロケールでも禁じる", () => {
    for (const locale of ["ja", "en"] as const) {
      expect(ttsInstructionsForLocale(locale)).toContain(
        "Do not omit, add, translate, or answer anything",
      );
    }
  });

  it("日本語のときだけ、混ざった英単語の読み方を指示する", () => {
    expect(ttsInstructionsForLocale("ja")).toContain("English words");
    expect(ttsInstructionsForLocale("en")).not.toContain("English words");
  });
});

describe("sentenceTokenizerForLocale", () => {
  it("日本語は句点で切る(SDK既定は半角の文末記号しか見ない)", () => {
    expect(sentenceTokenizerForLocale("ja").tokenize("ここを見て。プラスだよね。")).toEqual([
      "ここを見て。",
      "プラスだよね。",
    ]);
  });

  it("英語は既定の英語向け規則のまま", () => {
    expect(
      sentenceTokenizerForLocale("en").tokenize(
        "Look at the discriminant here. It is positive, so what does that tell us?",
      ),
    ).toEqual(["Look at the discriminant here.", "It is positive, so what does that tell us?"]);
  });
});

describe("createSenpaiTts", () => {
  // Live は最初からWSを張れるので `StreamAdapter` で包まない。包むと1文ごとに
  // `synthesize()` が呼ばれて、WSを張った意味が消える。
  it("TTS_ENGINE=gemini-live でWSの実装へ差し替わる", () => {
    const tts = createSenpaiTts(testConfig({ TTS_ENGINE: "gemini-live" }), "ja");
    expect(tts).toBeInstanceOf(GeminiLiveTTS);
    expect(tts.capabilities.streaming).toBe(true);
    expect(tts.label).not.toContain("StreamAdapter");
  });

  // ElevenLabs も自前でWSを張るので、こちらも包まない。
  it("TTS_ENGINE=elevenlabs でElevenLabsへ差し替わる", () => {
    const tts = createSenpaiTts(
      testConfig({
        TTS_ENGINE: "elevenlabs",
        ELEVENLABS_API_KEY: "key",
        ELEVENLABS_VOICE_ID: "voice",
      }),
      "ja",
    );
    expect(tts).toBeInstanceOf(elevenlabs.TTS);
    expect(tts.capabilities.streaming).toBe(true);
    expect(tts.label).not.toContain("StreamAdapter");
    expect(tts.model).toBe("eleven_flash_v2_5");
  });

  it("既定(gemini)では従来のGemini TTSのまま", () => {
    const tts = createSenpaiTts(testConfig(), "ja");
    expect(tts).not.toBeInstanceOf(GeminiLiveTTS);
    expect(tts).not.toBeInstanceOf(elevenlabs.TTS);
  });

  // Gemini TTS は `stream()` が例外を投げる非ストリーミング実装。包まずに渡すと
  // SDKが既定のBasicSentenceTokenizerで勝手に包み、日本語が句点で切れなくなる。
  it("StreamAdapterで包んでからセッションへ渡す", () => {
    const tts = createSenpaiTts(testConfig(), "ja");
    expect(tts.capabilities.streaming).toBe(true);
    expect(tts.label).toContain("StreamAdapter");
  });
});

describe("createVoiceSession", () => {
  function session() {
    return createVoiceSession({
      // VADはWorkerのprewarmが積むもので、組み立ての検証には要らない。
      ctx: { proc: { userData: {} } } as never,
      config: testConfig(),
      locale: "ja",
      llmTemperature: 0.6,
    });
  }

  // 既定は `preemptiveTts: false` で、TTSはターン確定まで動き出さない。
  // Gemini TTS は最初の音までが重いので、endpointing の待ちと直列に積み上がる。
  it("TTSもターン確定前に走らせる", () => {
    const { preemptiveGeneration } = session().sessionOptions.turnHandling;
    expect(preemptiveGeneration.enabled).toBe(true);
    expect(preemptiveGeneration.preemptiveTts).toBe(true);
  });

  // 見切り発車は外したぶんを捨てる。既定の歯止めまで一緒に外していないことを縛る。
  it("先読みの歯止めは既定のまま残す", () => {
    const { preemptiveGeneration } = session().sessionOptions.turnHandling;
    expect(preemptiveGeneration.maxRetries).toBe(3);
    expect(preemptiveGeneration.maxSpeechDuration).toBe(10_000);
  });

  // `resolveEndpointing` は部分指定を既定へ併合する。preemptiveGeneration を足したことで
  // 隣の endpointing が既定へ戻っていないか(併合の取りこぼし)をここで見る。
  it("endpointing の指定を保つ", () => {
    const { endpointing } = session().sessionOptions.turnHandling;
    expect(endpointing.minDelay).toBe(300);
    expect(endpointing.maxDelay).toBe(4_000);
  });

  // 1万トークン級の指示文が毎ターン再送されるので、素の `anthropic.LLM` では原価が乗る。
  it("会話LLMはキャッシュの印を付ける版を使う", () => {
    expect(session().llm).toBeInstanceOf(CachedInstructionsLLM);
  });
});
