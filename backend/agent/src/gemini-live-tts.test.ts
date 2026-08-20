import { initializeLogger, tts } from "@livekit/agents";
import { beforeAll, describe, expect, it } from "vitest";
import { GeminiLiveTTS } from "./gemini-live-tts.ts";
import { JapaneseSentenceTokenizer } from "./sentence-tokenizer.ja.ts";

type SentTurn = { turns: { role: string; parts: { text: string }[] }[]; turnComplete: boolean };
type Callbacks = { onmessage: (message: unknown) => void; onclose: () => void };

/**
 * 各文は12字より長くする。`JapaneseSentenceTokenizer` は
 * `BufferedSentenceStream` の最小長(12字)を下回る文を隣とくっつけるので、
 * 短い例文だと「1文=1ターン」の検証にならない。
 */
/** 1フレームは 24000/10 × 2byte = 4800。2フレームぶん送って端数を残す。 */
const framesPerTurn = 2;
const audioBytesPerTurn = 4800 * framesPerTurn;

/**
 * Live のWSを差し替える。**実APIは叩かない。**
 * ここで縛りたいのはターンの数え方とフレームの流し方で、そこはネットワークの外にある。
 */
function fakeLive(options: { silentTurns?: number } = {}) {
  const sent: SentTurn[] = [];
  const connects: { model: string; config: Record<string, unknown> }[] = [];
  let closed = false;

  const connect = async (params: {
    model: string;
    config: Record<string, unknown>;
    callbacks: Callbacks;
  }) => {
    connects.push({ model: params.model, config: params.config });
    return {
      sendClientContent(turn: SentTurn) {
        sent.push(turn);
        const index = sent.length;
        // サーバの往復を模す。同期で返すと、送信ループと受信の順序が本物とずれる。
        setTimeout(() => {
          const silent = index <= (options.silentTurns ?? 0);
          params.callbacks.onmessage({
            serverContent: {
              modelTurn: silent
                ? { parts: [] }
                : {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "audio/pcm;rate=24000",
                          data: Buffer.alloc(audioBytesPerTurn).toString("base64"),
                        },
                      },
                    ],
                  },
              generationComplete: true,
            },
          });
        }, 0);
      },
      close() {
        closed = true;
      },
    };
  };

  return { connect, sent, connects, isClosed: () => closed };
}

function liveTts(fake: ReturnType<typeof fakeLive>) {
  const instance = new GeminiLiveTTS({
    apiKey: "test-key",
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    voiceName: "Leda",
    locale: "ja",
    sentenceTokenizer: new JapaneseSentenceTokenizer(),
  });
  (instance.client as unknown as { live: { connect: unknown } }).live = { connect: fake.connect };
  return instance;
}

async function speak(instance: GeminiLiveTTS, text: string) {
  const stream = instance.stream();
  stream.pushText(text);
  stream.endInput();

  const frames: { final: boolean }[] = [];
  let sawEndOfStream = false;
  for await (const event of stream) {
    if (event === tts.SynthesizeStream.END_OF_STREAM) {
      sawEndOfStream = true;
      break;
    }
    frames.push({ final: event.final });
  }
  stream.close();
  return { frames, sawEndOfStream };
}

describe("GeminiLiveTTS", () => {
  beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));

  // 包まずにセッションへ渡せることが Live を選ぶ理由そのもの。ここが false に戻ると
  // SDKが `StreamAdapter` を勝手に当てて、WSの意味が消える。
  it("ストリーミング対応として名乗る", () => {
    const instance = liveTts(fakeLive());
    expect(instance.capabilities.streaming).toBe(true);
    expect(instance.sampleRate).toBe(24_000);
    expect(instance.numChannels).toBe(1);
  });

  it("声・モデル・逐語読みの指示を接続時に渡す", async () => {
    const fake = fakeLive();
    await speak(liveTts(fake), "ここの判別式を見てみようか。");

    expect(fake.connects).toHaveLength(1);
    const config = fake.connects[0]?.config as {
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
      systemInstruction: string;
      temperature: number;
    };
    expect(fake.connects[0]?.model).toBe("gemini-2.5-flash-native-audio-preview-12-2025");
    expect(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Leda");
    expect(config.temperature).toBe(0);
    // 対話モデルに読み上げをさせている。ここが抜けると先輩が板書に返事をしはじめる。
    expect(config.systemInstruction).toContain("text-to-speech engine");
    expect(config.systemInstruction).toContain("Never answer a question");
  });

  // 全文を1ターンで投げると、最初の音までの待ちが生成完了待ちになる。
  it("1文を1ターンとして送る", async () => {
    const fake = fakeLive();
    await speak(liveTts(fake), "ここの判別式を見てみようか。符号はプラスになっているよね。");

    expect(fake.sent.map((turn) => turn.turns[0]?.parts[0]?.text)).toEqual([
      "ここの判別式を見てみようか。",
      "符号はプラスになっているよね。",
    ]);
    expect(fake.sent.every((turn) => turn.turnComplete)).toBe(true);
  });

  it("フレームを順に流し、最後の1つにだけ final を立てて END_OF_STREAM で閉じる", async () => {
    const { frames, sawEndOfStream } = await speak(
      liveTts(fakeLive()),
      "ここの判別式を見てみようか。符号はプラスになっているよね。",
    );

    expect(frames.length).toBe(framesPerTurn * 2);
    expect(frames.filter((frame) => frame.final)).toHaveLength(1);
    expect(frames.at(-1)?.final).toBe(true);
    expect(sawEndOfStream).toBe(true);
  });

  it("読み上げを終えたら接続を閉じる", async () => {
    const fake = fakeLive();
    await speak(liveTts(fake), "ここの判別式を見てみようか。");
    expect(fake.isClosed()).toBe(true);
  });

  // 安全フィルタなどで音声が付かないターンがありうる。数え方が送信側だけだと
  // そこで待ち続けて発話が終わらない。生成完了の数で閉じることを縛る。
  it("音声が返らないターンがあっても止まらない", async () => {
    const { sawEndOfStream, frames } = await speak(
      liveTts(fakeLive({ silentTurns: 1 })),
      "ここの判別式を見てみようか。符号はプラスになっているよね。",
    );
    expect(sawEndOfStream).toBe(true);
    expect(frames.length).toBe(framesPerTurn);
  });
});
