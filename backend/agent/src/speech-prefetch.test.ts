import { describe, expect, it, vi } from "vitest";
import { type PendingSpeech, SpeechPrefetcher } from "./speech-prefetch.ts";

/**
 * 手順ごとの読み上げの**先読み**。見たいのは4つ:
 *
 *   1. 下流が読み上げで止まっている間も、先読みは先へ進むこと(これが本体)
 *   2. 渡すのは**完成したものだけ**で、間に合わなければ今までどおりの経路に落ちること
 *   3. チャンクは1つも足さず・減らさず・順番どおりに素通しすること
 *   4. 走査が壊れても、配送は止まらないこと
 */

type Frame = { readonly id: string };

/** テスト用の音声フレーム。中身は見ないので、区別が付けばよい。 */
function frame(id: string): Frame {
  return { id };
}

type FakeSynthesis = {
  readonly text: string;
  readonly cancelled: () => boolean;
  finish(frames: readonly Frame[]): void;
  fail(): void;
};

/** 合成の完了を手で握れる偽物。**時間ではなく順序でテストする。** */
function fakeSynthesizer() {
  const calls: FakeSynthesis[] = [];

  const synthesize = (text: string): PendingSpeech => {
    let settle: (frames: readonly Frame[] | null) => void = () => undefined;
    const frames = new Promise<readonly Frame[] | null>((resolve) => {
      settle = resolve;
    });
    let cancelled = false;
    calls.push({
      text,
      cancelled: () => cancelled,
      finish: (result) => settle(result),
      fail: () => settle(null),
    });
    return {
      frames: frames as PendingSpeech["frames"],
      cancel: () => {
        cancelled = true;
        settle(null);
      },
    };
  };

  return { calls, synthesize: synthesize as unknown as (text: string) => PendingSpeech };
}

function lessonJson(speeches: readonly string[]): string {
  const steps = speeches.map((speech, index) => ({
    index,
    speech,
    board: { kind: "latex", tex: "x=1" },
  }));
  return JSON.stringify({ title: "二次不等式", topic_ids: ["M1-NIJI-FUTOSHIKI"], steps });
}

/** チャンクを配るだけの上流。実際のLLMと同じく、下流の歩幅とは無関係に用意されている。 */
async function* chunksOf(text: string, size = 24): AsyncGenerator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

/** マイクロタスクを流し切る(ポンプが先へ進むのを待つ)。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function readFrames(stream: ReturnType<SpeechPrefetcher["take"]>): Promise<readonly Frame[]> {
  if (stream === null) return [];
  const reader = (stream as unknown as ReadableStream<Frame>).getReader();
  const frames: Frame[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) frames.push(value);
  }
  return frames;
}

describe("SpeechPrefetcher", () => {
  /**
   * これが機能の本体。`board.ts` の `onStep` は読み上げ終わりまで返らないので、
   * 下流は1チャンク目で止まったままになる。**その裏で先の手順の合成が始まっていること**が、
   * 手順ごとのTTFBを消す唯一の条件。
   */
  it("下流が1チャンク目で止まっていても、先の手順の合成を始める", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    const observed = prefetcher.observe(
      chunksOf(lessonJson(["まず一言。", "次はここ。", "最後。"])),
    );
    const iterator = observed[Symbol.asyncIterator]();
    await iterator.next(); // 1チャンク引いたきり、下流は読み上げで止まっている

    await settle();

    expect(calls.map((call) => call.text)).toEqual(["次はここ。", "最後。"]);
  });

  /** 最初の手順はパースした直後に喋る。先読みしても捨てるだけで、課金しか残らない。 */
  it("最初の手順は先読みしない", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    await collect(prefetcher.observe(chunksOf(lessonJson(["まず一言。", "次はここ。"]))));

    expect(calls.map((call) => call.text)).toEqual(["次はここ。"]);
  });

  it("完成していれば、その手順の音声を渡す", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    await collect(prefetcher.observe(chunksOf(lessonJson(["まず一言。", "次はここ。"]))));
    calls[0]?.finish([frame("a"), frame("b")]);
    await settle();

    expect(await readFrames(prefetcher.take("次はここ。"))).toEqual([frame("a"), frame("b")]);
  });

  /**
   * **走っている合成はそのまま渡さない。**`ChunkedStream` は失敗するとリクエストごと
   * 再試行するので、フレームを流し始めたあとの再試行はその手順を二重に喋らせる。
   * 間に合わなかったぶんは捨てて、通常経路(今までと同じ待ち)へ落とす。
   */
  it("まだ合成中なら渡さず、抱えていたぶんを捨てる", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    await collect(prefetcher.observe(chunksOf(lessonJson(["まず一言。", "次はここ。"]))));

    expect(prefetcher.take("次はここ。")).toBeNull();
    expect(calls[0]?.cancelled()).toBe(true);
  });

  it("合成が失敗していたら渡さない", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    await collect(prefetcher.observe(chunksOf(lessonJson(["まず一言。", "次はここ。"]))));
    calls[0]?.fail();
    await settle();

    expect(prefetcher.take("次はここ。")).toBeNull();
  });

  /** 作り直し(`StepRepair`)で文が変わった手順は、先読みと一致しない。 */
  it("文が違えば渡さない", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    await collect(prefetcher.observe(chunksOf(lessonJson(["まず一言。", "次はここ。"]))));
    calls[0]?.finish([frame("a")]);
    await settle();

    expect(prefetcher.take("作り直した別の文。")).toBeNull();
  });

  it("チャンクを足さず・減らさず・順番どおりに流す", async () => {
    const { synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });
    const source = ['{"title":"', '見出し","topic_ids":[]', ',"steps":[]}'];

    const seen = await collect(prefetcher.observe(arrayChunks(source)));

    expect(seen).toEqual(source);
  });

  /** 正本のパースは下流にある。ここが読めなかったのは、先読みを諦める理由でしかない。 */
  it("走査が壊れても、チャンクは流れ続ける", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const warn = vi.fn();
    const prefetcher = new SpeechPrefetcher({
      synthesize,
      log: { info: vi.fn(), warn },
    });
    // `steps` の要素が数値。走査器は契約違反として投げる。
    const broken = '{"title":"見出し","topic_ids":[],"steps":[1,2]}';

    const seen = await collect(prefetcher.observe(arrayChunks([broken])));

    expect(seen.join("")).toBe(broken);
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith("board_speech_prefetch_scan_failed", expect.anything());
  });

  /** 上流の失敗は握り潰さない(下流は途中まで届いた手順を有効な板書として扱う)。 */
  it("上流が投げたら、溜まっているぶんを流し切ってから投げる", async () => {
    const { synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    async function* failing(): AsyncGenerator<string> {
      yield "先に届いたぶん";
      throw new Error("上流が切れた");
    }

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of prefetcher.observe(failing())) seen.push(chunk);
      })(),
    ).rejects.toThrow(/上流が切れた/);
    expect(seen).toEqual(["先に届いたぶん"]);
  });

  /**
   * 問いかけで降りた回・割り込まれた回に、聞かれない手順の合成を積み上げない。
   * 先読みは「1つ喋っている間に次の1つ」に必要な数だけ。
   */
  it("先読みの数を超えて走らせない", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize, lookahead: 2 });

    await collect(
      prefetcher.observe(
        chunksOf(lessonJson(["1つめ。", "2つめ。", "3つめ。", "4つめ。", "5つめ。"])),
      ),
    );

    expect(calls.map((call) => call.text)).toEqual(["2つめ。", "3つめ。"]);

    // 取り出すと枠が空き、次の手順が走り出す。
    calls[0]?.finish([frame("a")]);
    await settle();
    prefetcher.take("2つめ。");
    expect(calls.map((call) => call.text)).toEqual(["2つめ。", "3つめ。", "4つめ。"]);
  });

  /**
   * 作り直しで文が変わった手順の先読みは、二度と一致しない。枠を塞いだまま残すと
   * **そのパスの残りが全部先読みなしになる**ので、追い越された時点で捨てる。
   */
  it("追い越された先読みは、次に一致した時点で捨てる", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize, lookahead: 2 });

    await collect(
      prefetcher.observe(chunksOf(lessonJson(["1つめ。", "2つめ。", "3つめ。", "4つめ。"]))),
    );
    expect(calls.map((call) => call.text)).toEqual(["2つめ。", "3つめ。"]);

    // 2つめは作り直されて別の文で配送された(先読みは一致しない)。
    expect(prefetcher.take("作り直した2つめ。")).toBeNull();
    calls[1]?.finish([frame("c")]);
    await settle();

    // 3つめは先読みが効く。古い2つめのぶんはここで捨てられ、枠が空く。
    expect(await readFrames(prefetcher.take("3つめ。"))).toEqual([frame("c")]);
    expect(calls[0]?.cancelled()).toBe(true);
    expect(calls.map((call) => call.text)).toEqual(["2つめ。", "3つめ。", "4つめ。"]);
  });

  /** パスが変われば、前のパスの先読みは古い文脈の音声でしかない。 */
  it("次のパスに入るとき、前のパスの先読みを捨てる", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    await collect(prefetcher.observe(chunksOf(lessonJson(["まず一言。", "次はここ。"]))));
    expect(calls[0]?.cancelled()).toBe(false);

    await collect(prefetcher.observe(chunksOf(lessonJson(["続き。", "その次。"]))));

    expect(calls[0]?.cancelled()).toBe(true);
    expect(prefetcher.take("次はここ。")).toBeNull();
  });

  it("cancelAll で抱えているぶんを捨てる", async () => {
    const { calls, synthesize } = fakeSynthesizer();
    const prefetcher = new SpeechPrefetcher({ synthesize });

    await collect(prefetcher.observe(chunksOf(lessonJson(["まず一言。", "次はここ。"]))));
    prefetcher.cancelAll();

    expect(calls[0]?.cancelled()).toBe(true);
  });
});

async function* arrayChunks(chunks: readonly string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const seen: string[] = [];
  for await (const chunk of chunks) seen.push(chunk);
  return seen;
}
