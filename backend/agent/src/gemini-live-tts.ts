import type { Locale } from "@ai-sensei/contract";
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage, Session } from "@google/genai";
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  shortuuid,
  type tokenize,
  tts,
} from "@livekit/agents";
import { liveTtsSystemInstruction } from "./senpai-voice.ts";

/** Live API の音声出力は 24kHz モノラル固定(`realtime/realtime_api.js` の定数と同じ)。 */
const sampleRate = 24_000;
const numChannels = 1;

export type GeminiLiveTtsOptions = {
  apiKey: string;
  model: string;
  voiceName: string;
  locale: Locale;
  /** 文の切り方。1文が1ターンになるので、ここが最初の音までの待ちを決める。 */
  sentenceTokenizer: tokenize.SentenceTokenizer;
};

/**
 * Live API を**読み上げ専用**に使うTTS。
 *
 * ねらいは単価ではなく接続の形。TTSモデル(`google.beta.TTS`)は
 * `capabilities.streaming === false` で、**1文ごとに新しいHTTPリクエスト**になる。
 * Live は WebSocket なので、LLMが文を吐き終える前に接続を張っておける。
 * Deepgramの頃の形(発話ごとに1本のWSへ文字を流し込む)に戻る。
 *
 * **代償を承知で使うこと。**
 * - 音声出力は $12.00/1M(約 $0.018/分)。2.5 のTTSモデルは $10.00/1M(約 $0.015/分)で、
 *   **2割高い**。安くはならない
 * - **Live は対話モデル**。読み上げは訓練の逆方向で、要約・相槌・返答が起きうる。
 *   歯止めは `liveTtsSystemInstruction` の1枚だけ
 * - preview。`TTS_ENGINE=gemini` で即座に元のTTSモデルへ戻せるようにしてある
 *
 * 接続は `stream()` 1回につき1本 = **先輩の1発話につき1本**。SDKの `ttsNode` が
 * 発話ごとに `stream()` を呼ぶためで、Deepgramのプラグインと同じ寿命になる。
 * Live のセッション上限(音声のみ15分 / WS約10分)は1発話では届かないので、
 * `sessionResumption` も `contextWindowCompression` も要らない。
 */
export class GeminiLiveTTS extends tts.TTS {
  readonly opts: GeminiLiveTtsOptions;
  readonly client: GoogleGenAI;
  label = "google.gemini.LiveTTS";

  constructor(opts: GeminiLiveTtsOptions) {
    super(sampleRate, numChannels, { streaming: true });
    this.opts = opts;
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  override get model(): string {
    return this.opts.model;
  }

  override get provider(): string {
    return "google";
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new GeminiLiveSynthesizeStream(this, options?.connOptions);
  }

  /**
   * 一括合成。`AgentSession` は常に `stream()` を通るので通らない経路だが、
   * `tts.TTS` の抽象として塞いでおく(投げると `session.say()` の一部が落ちうる)。
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new GeminiLiveChunkedStream(text, this, connOptions, abortSignal);
  }
}

/**
 * 1発話ぶんのWS。**1文 = 1ターン**で投げ、返ってきた音声フレームを順に流す。
 *
 * ターンを分けるのは、Live が `turnComplete` を受け取るまで生成を始めないため。
 * 全文を溜めてから1ターンで投げると、最初の音までの待ちが生成完了待ちになる。
 */
class GeminiLiveSynthesizeStream extends tts.SynthesizeStream {
  readonly #tts: GeminiLiveTTS;
  readonly #tokenizer: tokenize.SentenceStream;
  label = "google.gemini.LiveSynthesizeStream";

  constructor(ttsInstance: GeminiLiveTTS, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#tokenizer = ttsInstance.opts.sentenceTokenizer.stream();
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(sampleRate, numChannels);

    // 1フレーム分だけ手元に残して、最後のフレームに `final` を立てられるようにする
    // (SDKはこの印でセグメントの終わりとメトリクスの確定を判断する)。
    let lastFrame: ReturnType<typeof bstream.write>[number] | undefined;
    const emit = (final: boolean) => {
      if (lastFrame && !this.queue.closed) {
        this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };
    const pushAudio = (pcm: Buffer) => {
      for (const frame of bstream.write(
        pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
      )) {
        emit(false);
        lastFrame = frame;
      }
    };

    let session: Session | undefined;
    let closedByUs = false;
    let failure: Error | undefined;
    // 送った文の数と、生成完了(`generationComplete`)を受け取った数。
    // 一致するまで待ってから閉じる。片方だけ数えると、最後の文が鳴らないまま切れる。
    let turnsSent = 0;
    let turnsDone = 0;
    let inputEnded = false;
    let settle: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const settleIfDone = () => {
      if (inputEnded && turnsDone >= turnsSent) settle?.();
    };
    const fail = (error: Error) => {
      failure ??= error;
      settle?.();
    };

    const onMessage = (message: LiveServerMessage) => {
      const content = message.serverContent;
      for (const part of content?.modelTurn?.parts ?? []) {
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith("audio/")) {
          pushAudio(Buffer.from(inline.data, "base64"));
        }
      }
      // `goAway` はサーバ側が接続を畳む予告。1発話ぶんの寿命では通常来ないが、
      // 来たら握り潰さずに失敗させる(黙って途中で切れるより原因が分かる)。
      if (message.goAway) {
        fail(
          new APIStatusError({
            message: "Gemini Live TTS: サーバが接続を閉じようとしています(goAway)",
            options: { statusCode: 503, retryable: true },
          }),
        );
        return;
      }
      if (content?.generationComplete || content?.turnComplete) {
        turnsDone += 1;
        settleIfDone();
      }
    };

    try {
      session = await this.#tts.client.live.connect({
        model: this.#tts.opts.model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.#tts.opts.voiceName } },
          },
          systemInstruction: liveTtsSystemInstruction(this.#tts.opts.locale),
          // 読み上げに creativity は要らない。文体の揺れは先輩の一貫性を壊す。
          temperature: 0,
        },
        callbacks: {
          onmessage: onMessage,
          onerror: (event: { message?: string }) =>
            fail(
              new APIConnectionError({
                message: `Gemini Live TTS: 接続エラー - ${event.message || "unknown"}`,
                options: { retryable: true },
              }),
            ),
          onclose: () => {
            if (closedByUs) return;
            fail(
              new APIStatusError({
                message: "Gemini Live TTS: 接続が予期せず閉じました",
                options: { statusCode: -1, retryable: true },
              }),
            );
          },
        },
      });
    } catch (error) {
      throw new APIConnectionError({
        message: `Gemini Live TTS: 接続できません - ${error instanceof Error ? error.message : String(error)}`,
        options: { retryable: true },
      });
    }

    const live = session;
    const forwardInput = async () => {
      for await (const chunk of this.input) {
        if (this.abortController.signal.aborted) break;
        if (chunk === tts.SynthesizeStream.FLUSH_SENTINEL) {
          this.#tokenizer.flush();
          continue;
        }
        this.#tokenizer.pushText(chunk);
      }
      this.#tokenizer.endInput();
      this.#tokenizer.close();
    };

    const sendSentences = async () => {
      for await (const event of this.#tokenizer) {
        if (this.abortController.signal.aborted) break;
        // **文を送る直前に打つ。**上流(LLMの生成・文分割)の待ちがTTFBに混ざらない。
        this.markStarted();
        live.sendClientContent({
          turns: [{ role: "user", parts: [{ text: event.token }] }],
          turnComplete: true,
        });
        turnsSent += 1;
      }
      inputEnded = true;
      settleIfDone();
    };

    try {
      await Promise.all([forwardInput(), sendSentences()]);
      await finished;
      if (failure) throw failure;
      if (this.abortController.signal.aborted) return;

      for (const frame of bstream.flush()) {
        emit(false);
        lastFrame = frame;
      }
      emit(true);
      if (!this.queue.closed) this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    } finally {
      closedByUs = true;
      try {
        live.close();
      } catch {
        // 既に閉じている。閉じ損ねよりも、上位へ元の失敗を返すほうが大事。
      }
    }
  }
}

/**
 * `synthesize()` 用。1文を1回のWSで読み上げて全フレームを流す。
 * ストリーム版と同じ経路を使い回すため、`SynthesizeStream` を内部で1回だけ回す。
 */
class GeminiLiveChunkedStream extends tts.ChunkedStream {
  readonly #tts: GeminiLiveTTS;
  // 基底の `_connOptions` は private で読めないので、渡された値をこちらでも持つ。
  readonly #connOptions: APIConnectOptions | undefined;
  label = "google.gemini.LiveChunkedStream";

  constructor(
    text: string,
    ttsInstance: GeminiLiveTTS,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#tts = ttsInstance;
    this.#connOptions = connOptions;
  }

  protected async run(): Promise<void> {
    const stream = this.#tts.stream({ connOptions: this.#connOptions });
    stream.pushText(this.inputText);
    stream.endInput();
    try {
      for await (const event of stream) {
        if (event === tts.SynthesizeStream.END_OF_STREAM) break;
        if (this.abortSignal.aborted) break;
        this.queue.put(event);
      }
    } finally {
      stream.close();
      this.queue.close();
    }
  }
}
