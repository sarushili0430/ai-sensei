/**
 * 授業の**間(ま)**。手順と手順のあいだに、実時間の沈黙を置く層。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【なぜ要るか】読み上げが終わった瞬間に次が始まると、置いていかれる
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 授業モードは板書1行につき1回 `say(...).waitForPlayout()` する
 * (`agent.ts` の `speak`)。待つのは**再生が終わるまで**なので、終わった次の
 * ミリ秒には次の行が板に出て、次の声が始まる。生徒は聞きながら板書を目で追って
 * いるので、飲み込む前に次が来る —— 8/25 のドッグフーディングで出た
 * 「ちょっと早く喋りすぎ。文章と文章の間が早すぎて、置いてかれる人がいる」はこれ。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【足すのではなく、目標まで埋める】沈黙は積み上げない
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 最初の実装は「読み上げ終わりに700ms黙る」だった。次のドッグフーディングで
 * 返ってきたのは**逆の苦情** ——「間隔を開けすぎて、文章が途切れになってしまう」。
 *
 * 理由は積み上げ。手順と手順のあいだには、もともと沈黙がある:
 *
 *   - 板書LLMが次の手順を書き終えるまでの生成待ち
 *   - 手順の検証・作り直し(`board.ts` の `settleStep`)
 *   - **TTSの最初の音までの待ち(TTFB)**。先読み(`speech-prefetch.ts`)が
 *     外れた手順は、ここで1〜2秒黙る
 *
 * そこへ固定の700msを足していたので、外れた手順の間は2秒を超える。
 * だからここが持つのは「足す長さ」ではなく**「間はこれくらい空いていてほしい」
 * という目標**({@link StepPacer})で、実際に黙るのは**目標に足りないぶんだけ**。
 * すでに空いていれば1ミリ秒も足さない。
 *
 * **合成待ちの沈黙も間の一部**として数える。呼び出し側は、音がすぐ出ると
 * 分かっている手順(先読みが当たった手順)でだけここを通す —— 外れた手順は
 * TTFBがそのまま間になるので、足すと二度目の間になってしまう。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【間は、待たせている時間ではない】止めるものは即座に止める
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 沈黙は「読ませる時間」であって「待たせる時間」ではないので、**降りたい人を
 * ここで足止めしない**。「わかった」を押した・セッションが終わった・生徒が
 * 割り込んだ、のどれでも、間はその瞬間に切り上げる。
 */

/**
 * 手順と手順のあいだに空いていてほしい間の既定値(ミリ秒)。**足す長さではない。**
 *
 * 1手順の音声は中央値2.5秒(`board-stream.ts` の実測)。0.5秒は、そこに
 * **文1つぶんの息継ぎ**を足す長さで、板書1行を目で追い直せる。
 * 700msから下げたのは、8/25 の2回目のドッグフーディングで
 * 「間隔を開けすぎて、文章が途切れになってしまう」が出たため — 積み上げを
 * 止めた({@link StepPacer})うえで、目標そのものも一段詰めている。
 *
 * 手元で詰めるときは `LESSON_STEP_PAUSE_MS` で動かす(0で従来どおり切れ目なし)。
 */
export const defaultStepPauseMs = 500;

/**
 * [ms] だけ黙る。[signals] のどれかが落ちたら、その瞬間に切り上げる。
 *
 * `AbortSignal` を**複数**受けるのは、切り上げる理由が2つ以上あるため
 * (セッションの終わり / 「わかった」)。どれか1つでも落ちていれば即座に返る。
 */
export function pauseBetweenSteps(ms: number, signals: readonly AbortSignal[] = []): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  if (signals.some((signal) => signal.aborted)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    for (const signal of signals) signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * 手順と手順のあいだの間を、**目標まで埋める**係。
 *
 * 持っているのは「直前の手順を読み終えた時刻」だけ。次の手順を読み上げる直前に
 * {@link wait} を呼ぶと、そこまでに**すでに経過したぶんを差し引いて**、
 * 足りないぶんだけ黙る。板書LLMの生成待ちも検証の待ちも間の一部として数えるので、
 * 遅い手順に固定の沈黙が積み上がらない。
 *
 * 起点は{@link markSpoken}が刻む。パスをまたいでも捨てなくてよい ——
 * 生徒が答えている数秒のあいだに目標は満ちるので、次のパスの1手順目では
 * どのみち0になる。
 */
export class StepPacer {
  readonly #gapMs: number;
  readonly #now: () => number;
  /** 直前の手順を読み終えた時刻。まだ1手順も読んでいなければ undefined。 */
  #spokenAt: number | undefined;

  constructor(options: { gapMs: number; now?: () => number }) {
    this.#gapMs = options.gapMs;
    this.#now = options.now ?? Date.now;
  }

  /** 目標まで、あと何ミリ秒足りないか。すでに満ちていれば0。 */
  shortfallMs(): number {
    if (!(this.#gapMs > 0)) return 0;
    if (this.#spokenAt === undefined) return 0;
    return Math.max(0, this.#gapMs - (this.#now() - this.#spokenAt));
  }

  /** 足りないぶんだけ黙る。止める合図が落ちていれば、その瞬間に切り上げる。 */
  wait(signals: readonly AbortSignal[] = []): Promise<void> {
    return pauseBetweenSteps(this.shortfallMs(), signals);
  }

  /** 手順を1つ読み終えた。ここが次の間の起点になる。 */
  markSpoken(): void {
    this.#spokenAt = this.#now();
  }
}
