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
 * **1つの手順の中の文と文**の間は TTS への指示で空ける
 * (`senpai-voice.ts` の `sentencePacingInstruction`)。ここが受け持つのは
 * **手順と手順のあいだ**で、そちらはモデルの気分に任せず実時間で持つ。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【間は、待たせている時間ではない】止めるものは即座に止める
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 沈黙は「読ませる時間」であって「待たせる時間」ではないので、**降りたい人を
 * ここで足止めしない**。「わかった」を押した・セッションが終わった・生徒が
 * 割り込んだ、のどれでも、間はその瞬間に切り上げる。
 *
 * 先読み(`speech-prefetch.ts`)とは相性がいい。次の手順の合成はこの沈黙の裏で
 * 進むので、間を置くほど TTFB が隠れる。
 */

/**
 * 手順と手順のあいだに置く間の既定値(ミリ秒)。
 *
 * 1手順の音声は中央値2.5秒(`board-stream.ts` の実測)。0.7秒は、そこに
 * **文1つぶんの息継ぎ**を足す長さで、板書1行を目で追い直せる。
 * これ以上長くすると、短い相づちの手順が続いたときに会話が間延びする。
 *
 * 手元で詰めるときは `LESSON_STEP_PAUSE_MS` で動かす(0で従来どおり切れ目なし)。
 */
export const defaultStepPauseMs = 700;

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
