import { voice } from "@livekit/agents";
import type { JobLogger } from "./log.ts";

/**
 * 声のパイプラインが転んだときに、**授業ごと降ろすかどうか**の判断。
 *
 * 授業(`agent.ts`)と計画(`plan-session.ts`)が同じ判断をするので、ここへ寄せてある。
 * 片方だけ直すと、直したほうの症状だけが消えて「たまに途中で切れる」がもう片方に残る。
 *
 * ──────────────────────────────────────────────────────────────
 * 【`error` イベント1件で降りてはいけない】
 * ──────────────────────────────────────────────────────────────
 *
 * SDKの `error` は**失敗の通知であって、終了の宣言ではない**。出どころは
 * `llm/llm.ts` `stt/stt.ts` `tts/tts.ts` の `emitError` で、とくにLLMは
 * **再試行のたびに `recoverable: true` で1件出す**(既定は `maxRetry: 3`、
 * 1回の上限10秒)。Anthropic の 429・529・10秒超えは、**SDKが自力で
 * 立て直している最中に**このイベントとして飛んでくる。
 *
 * 終了を決めているのは `AgentSession._onError` のほうで、
 *
 *   - `recoverable: true` は**数えない**
 *   - LLM / TTS の `recoverable: false` は**3件まで見逃す**(先輩が喋れたら数え直し)
 *   - STT の `recoverable: false` はその場で閉じる
 *
 * を通ってから、本当に駄目なときだけ `Close`(`CloseReason.ERROR`)を出す。
 *
 * こちらが `error` で降りると、**SDKが黙って直せたはずの一瞬の失敗で授業が
 * 丸ごと終わる**。生徒からは、締めの言葉もないまま途中でブチッと切れたようにしか
 * 見えない(そのうえ `error` は `log` を通らないので、**理由がどこにも残らない**)。
 *
 * だからここでは**記録するだけ**にして、降りる判断は `Close` に一本化する。
 */

/** `Close` から決まる終わり方。「わかった」「時間切れ」は別経路で入る。 */
export type ClosedReason = "user_left" | "error";

/**
 * SDKが閉じた理由を `/complete` の `ended_reason` へ写す。
 *
 * **`user_left` は「生徒が降りた」の意味を守る。**ワーカーの入れ替え(`JOB_SHUTDOWN`)や
 * SDKが見限った(`ERROR`)を混ぜると、記録の上では「みんな自分から降りている」ことになり、
 * 途中で切れた回を数える手段が無くなる。
 */
export function endedReasonOfClose(reason: voice.ShutdownReason): ClosedReason {
  switch (reason) {
    case voice.CloseReason.PARTICIPANT_DISCONNECTED:
    // 自分で閉じた後片付け(`ended` が決まったあとの `session.close()`)。
    // そのときの `finish` は最初の1件しか採らないので、実際には記録に出ない。
    case voice.CloseReason.USER_INITIATED:
      return "user_left";
    default:
      return "error";
  }
}

/**
 * 終わりの合図を1か所で購読する。**`session.start()` より前に呼ぶこと。**
 *
 * イベントは1度きりなので、あとから張ると、その間の離脱とエラーを取りこぼす。
 */
export function watchSessionEnd(options: {
  session: voice.AgentSession;
  finish: (reason: ClosedReason) => void;
  log: Pick<JobLogger, "info" | "warn">;
}): void {
  const { session, finish, log } = options;

  session.on(voice.AgentSessionEventTypes.Error, (event) => {
    const failure = event.error;
    // `InterruptionDetectionError` だけは例外そのもの(内側の `error` を持たない)。
    const cause = "error" in failure ? failure.error : failure;
    const fields = {
      // どの部品が転んだか(`llm_error` / `stt_error` / `tts_error` …)。
      reason: failure.type,
      // どのベンダーの実装か(`google.beta.TTS` など)。本文は含まない。
      label: failure.label,
      // **`true` なら SDK は再試行中。**降りていないのはこれが理由。
      recoverable: failure.recoverable,
      error_name: cause.name,
      // 監視には送らない欄(`telemetry.ts` の許可リスト)。標準出力にだけ残す。
      error_message: cause.message,
    };
    // 再試行中は**まだ何も失われていない**(遅れるだけ)ので、監視には上げない。
    // 上げてしまうと、429の1回で「縮退」が立ち、本当に落ちた回が埋もれる。
    // 立て直せなかったぶんだけが、生徒に届かなかった1ターンとして縮退になる。
    if (failure.recoverable) log.info("voice_pipeline_error", fields);
    else log.warn("voice_pipeline_error", fields);
  });

  session.on(voice.AgentSessionEventTypes.Close, (event) => {
    finish(endedReasonOfClose(event.reason));
  });
}
