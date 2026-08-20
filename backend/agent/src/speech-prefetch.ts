import { BoardLessonStreamParser } from "./board-stream.ts";
import type { JobLogger } from "./log.ts";

/**
 * 手順ごとの読み上げを、**前の手順を再生している裏で先に合成しておく**層。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【なぜ要るか】授業モードは手順の数だけTTFBを払っている
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `agent.ts` の `speak` は `session.say(...).waitForPlayout()` で、板書1手順につき
 * 1回呼ばれる(`board.ts` の `onStep` の契約)。SDK(1.6.1)の `ttsTask` は
 * **`_waitForAuthorization()` を待ってから**合成を始めるので、次の手順の合成は
 * 前の手順の再生が終わるまで走り出さない。つまり授業はこうなる:
 *
 *     手順1: [TTFB 沈黙] 再生 → 手順2: [TTFB 沈黙] 再生 → 手順3: …
 *
 * 1手順の音声は中央値2.5秒(`board-stream.ts` の実測)なので、TTFBが1秒なら
 * **再生時間の4割が沈黙**になる。会話モードにこれが出ないのは、`StreamAdapter` が
 * 文が切れた端から `synthesize()` を呼び、`await prevTask` で待つのは**排出だけ**
 * だから — 会話が払うTTFBは1文目の1回きり。授業だけが手順の数だけ払っている。
 *
 * ここが埋めるのはその差。**板書→音声の順番(§3-2)も、読み上げ終わりまで待つ約束も
 * 変えない。**変えるのは「いつ合成を始めるか」だけ。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【完成したものしか渡さない】合成中のものは捨てて通常経路へ落とす
 * ─────────────────────────────────────────────────────────────────────────
 *
 * {@link SpeechPrefetcher.take} が返すのは**合成しきって成功した音声だけ**で、
 * 間に合わなかったものは捨てて `null` を返す(呼び出し側は素の `say(text)` へ落ちる)。
 * 走っている合成をそのまま渡さないのは、`ChunkedStream` が失敗時に**リクエストごと
 * 再試行する**から。フレームを流し始めたあとで再試行が走ると、その手順は
 * 頭から二重に喋る。半端に速いより、**今までと同じ**ほうがいい。
 *
 * この設計のおかげで、先読みが外れても**新しい壊れ方が増えない**:
 *
 *   - 完成していた   → 音声を渡す(沈黙が消える)
 *   - まだ合成中     → 捨てて通常経路(今までと同じ待ち)
 *   - 合成が失敗した → 捨てて通常経路(今までと同じ待ち)
 *   - 作り直しで文が変わった → キーが一致せず通常経路(今までと同じ待ち)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【最初の手順は先読みしない】
 * ─────────────────────────────────────────────────────────────────────────
 *
 * パスの最初の手順は、パースした直後にそのまま喋る。先読みを始めても
 * 間に合わないうちに `take` が来るので、**捨てるための合成に課金するだけ**になる。
 * 冒頭の沈黙はここではなく、板書LLMのTTFT(`lesson.ts` のプロンプトキャッシュ)と
 * 同梱の冒頭音声(`lesson_opening_audio.dart`)が受け持つ。
 */

/** LiveKitの型をここへ持ち込まないための別名(`@livekit/rtc-node` へ直接依存しない)。 */
type AudioFrame = import("@livekit/agents").tts.SynthesizedAudio["frame"];

export type PendingSpeech = {
  /**
   * 合成の結果。**失敗しても reject しない。**
   *
   * 先読みは落ちても授業を止めない — 落ちたことは `null` で伝えて、
   * 呼び出し側は通常経路へ落ちる。ここで投げると、誰も待っていない Promise の
   * unhandled rejection でプロセスごと落ちうる。
   */
  readonly frames: Promise<readonly AudioFrame[] | null>;
  /** もう要らないと分かった時点で捨てる(合成中なら止めて課金を切る)。 */
  cancel(): void;
};

export type SpeechSynthesizer = (text: string) => PendingSpeech;

/**
 * 先読みして持っておく手順の数(合成中 + 完成済みの合計)。
 *
 * 1にすると、完成した1つを抱えたまま次を始められず、パスの後半で先読みが途切れる。
 * 大きくすると、問いかけで止まったパス(`stopAfter`)や割り込みで**使わない手順を
 * 合成した課金**が増える。2は「1つ喋っている間に次の1つを用意する」に必要な最小。
 */
export const defaultSpeechLookahead = 2;

type Entry = {
  readonly text: string;
  readonly pending: PendingSpeech;
  settled: boolean;
  frames: readonly AudioFrame[] | null;
};

export type SpeechPrefetcherOptions = {
  synthesize: SpeechSynthesizer;
  lookahead?: number;
  log?: Pick<JobLogger, "info" | "warn">;
};

export class SpeechPrefetcher {
  readonly #synthesize: SpeechSynthesizer;
  readonly #lookahead: number;
  readonly #log?: Pick<JobLogger, "info" | "warn">;
  /** パース済みで、まだ合成を始めていないテキスト。 */
  #queued: string[] = [];
  /** 合成中か、完成して取り出されるのを待っているもの。到着順に並ぶ。 */
  #entries: Entry[] = [];

  constructor(options: SpeechPrefetcherOptions) {
    this.#synthesize = options.synthesize;
    this.#lookahead = options.lookahead ?? defaultSpeechLookahead;
    this.#log = options.log;
  }

  /**
   * 板書LLMのチャンク列を**先読みしながら**そのまま下流へ流す。
   *
   * 下流(`board.ts` の `append`)は手順を1つ配送するたびに読み上げ終わりまで止まるが、
   * ここのポンプはその裏で回り続ける。**それが先読みの素材を作る唯一の方法** —
   * 下流と同じ歩幅でチャンクを読んでいる限り、次の手順の文は再生が終わるまで現れない。
   *
   * 溜め込む量は板書1枚ぶん(`boardStreamMaxLength` = 64KB)が上限なので、
   * ここでのバッファは数十KBにしかならない。
   *
   * **1回の呼び出し = 1パス。**入口で前のパスの残りを捨てる — パスをまたいだ
   * 先読みは、作り直しや割り込みで文脈が変わったあとの古い音声でしかない。
   */
  observe(chunks: AsyncIterable<string>): AsyncIterable<string> {
    this.cancelAll();

    const parser = new BoardLessonStreamParser();
    const buffered: string[] = [];
    let parsing = true;
    /** このパスの最初の手順か。最初だけは先読みしない(冒頭の設計判断)。 */
    let first = true;
    let done = false;
    let failure: unknown;
    let stopped = false;
    let wake: (() => void) | undefined;

    const notify = () => {
      const resume = wake;
      wake = undefined;
      resume?.();
    };

    const scan = (chunk: string) => {
      if (!parsing) return;
      try {
        for (const event of parser.feed(chunk)) {
          if (event.type !== "step") continue;
          if (first) {
            first = false;
            continue;
          }
          const text = speechOf(event.raw);
          if (text !== null) this.#queued.push(text);
        }
      } catch (error) {
        // 走査に失敗しても授業は止めない。**正本のパースは下流にある** —
        // ここが読めなかったのは先読みを諦める理由であって、配送を止める理由ではない。
        parsing = false;
        this.#log?.warn("board_speech_prefetch_scan_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.#pump();
    };

    const pump = async () => {
      try {
        for await (const chunk of chunks) {
          if (stopped) break;
          buffered.push(chunk);
          scan(chunk);
          notify();
        }
      } catch (error) {
        failure = error;
      } finally {
        done = true;
        notify();
      }
    };

    return {
      [Symbol.asyncIterator]: async function* () {
        // ポンプは最初に引かれた時点で走り出す。以降は下流の歩幅と無関係に進む。
        void pump();
        try {
          while (true) {
            while (buffered.length > 0) {
              const chunk = buffered.shift();
              if (chunk !== undefined) yield chunk;
            }
            // 失敗は**溜まっているぶんを渡し切ってから**投げる。
            // 途中まで届いた手順は、下流にとって有効な板書だから。
            if (failure !== undefined) throw failure;
            if (done) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          stopped = true;
        }
      },
    };
  }

  /**
   * その手順の読み上げに使える音声を取り出す。**完成しているときだけ返す。**
   *
   * 一致しなかった・間に合わなかったときは、抱えていたぶんを捨てて `null`。
   * 捨てるのは、直後に呼び出し側が同じ文を通常経路で合成するため —
   * 走らせたままにすると同じ音声に二重で払う。
   */
  take(text: string): ReadableStream<AudioFrame> | null {
    const index = this.#entries.findIndex((entry) => entry.text === text);
    if (index === -1) return null;

    // **手前で追い越されたぶんは、もう喋られない。**手順は配送順に読み上げるので、
    // いま喋る文より前に並んでいる先読みは、作り直しで文が変わったか
    // `stopBefore` で抑止されたかのどちらか。捨てないと枠を塞いだまま残り、
    // そのパスの残りが先読みなしになる。
    const stale = this.#entries.splice(0, index);
    for (const dropped of stale) dropped.pending.cancel();

    const entry = this.#entries.shift();
    if (entry === undefined) return null;

    // 取り出したぶんの枠が空くので、次の手順の合成を始められる。
    this.#pump();

    if (!entry.settled || entry.frames === null) {
      entry.pending.cancel();
      return null;
    }
    return streamOfFrames(entry.frames);
  }

  /** 抱えている先読みを全部捨てる(パスの切り替え・授業の終わり)。 */
  cancelAll(): void {
    const entries = this.#entries;
    this.#entries = [];
    this.#queued = [];
    for (const entry of entries) entry.pending.cancel();
  }

  /** 先読みの枠が空いている間だけ、次のテキストの合成を始める。 */
  #pump(): void {
    while (this.#entries.length < this.#lookahead) {
      const text = this.#queued.shift();
      if (text === undefined) return;

      const pending = this.#synthesize(text);
      const entry: Entry = { text, pending, settled: false, frames: null };
      this.#entries.push(entry);
      void pending.frames.then((frames) => {
        entry.settled = true;
        entry.frames = frames;
      });
    }
  }
}

/**
 * 走査の生の値から読み上げ文だけを取り出す。
 *
 * ここは**契約を知らない層**でよい(検証は下流の `validateStep` が正本)。
 * 欲しいのは「この文字列を先に合成しておく」だけなので、`speech` が文字列で
 * 空でないことしか見ない。作り直しで文が変わったときは、`take` のキーが
 * 一致せず通常経路へ落ちる — それで足りる。
 */
function speechOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const speech = (raw as { speech?: unknown }).speech;
  if (typeof speech !== "string" || speech.trim() === "") return null;
  return speech;
}

function streamOfFrames(frames: readonly AudioFrame[]): ReadableStream<AudioFrame> {
  return new ReadableStream<AudioFrame>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
}
