/**
 * エージェントの構造化ログ。
 *
 * ここは**いちばん静かに壊れる場所**。ワーカーが動いていない・ディスパッチが
 * 来ない・カルテのLLMが落ちた、のどれが起きてもアプリからは
 * 「先輩が来ない / 板書が出ない / カルテが出ない」としか見えない。1行1JSONで、
 * ジョブの節目を必ず残す。
 *
 * | event                        | いつ |
 * | ---------------------------- | --- |
 * | `job_started`                | ジョブを受け取った(= ディスパッチは届いている) |
 * | `context_unreadable`         | 文脈が読めない。会話せずに切る |
 * | `conversation_started`       | セッションが立ち上がった(授業の**前**) |
 * | `review_hole_missing`        | 古いAPIの復習。板書なし会話へ縮退する |
 * | `lesson_interrupted_by_user` | 授業中に生徒が喋った。板書の生成を止めて会話へ |
 * | `lesson_awaiting_question_board` | `awaits_student: true` の問いが板書へ残ったか |
 * | `lesson_finished`            | 授業1回ぶんが終わった(手順数・締め方・検証落ちの数) |
 * | `lesson_opening_observed`    | 1パス目が問題の音読依頼だったか(本文は残さない) |
 * | `problem_readout_requested`  | 問題文が無い1パス目で音読を頼んだ |
 * | `problem_readout_captured`   | 音読直後の発話をセッション内の問題文へ採用した |
 * | `problem_readout_rejected`   | 音読直後の発話を安全に問題文として採用できなかった |
 * | `problem_readout_unexpected` | 問題文があるのに頼んだ、または音読を繰り返した |
 * | `lesson_empty`               | 板書が1行も出せなかった。**8/16のゲートを見る指標** |
 * | `board_publisher_missing`    | Text Streams の送り口が無い。板書なしで会話だけ続ける |
 * | `say_failed`                 | 読み上げに失敗した(セッションが閉じかけている等) |
 * | `voice_metrics`              | SDKが集めた遅延・音声時間・割り込み数。本文は出さない |
 * | `user_turn_transcribed`      | 生徒の1ターンが確定した(interim回数と文字数だけ) |
 * | `agent_false_interruption`   | 誤割り込みを自動再開できたか |
 * | `overlapping_speech`         | 発話の重なりを検出した(生音声と確率列は出さない) |
 * | `conversation_ended`         | 終わり方(completed / timeout / user_left / error) |
 * | `room_disconnect_failed`     | 部屋を出られなかった。アプリは残り時間まで降りられない |
 * | `karte_built`                | カルテができた(穴の数と所要時間) |
 * | `karte_failed`               | LLMかスキーマで落ちた。空のカルテを送る |
 * | `complete_posted`            | `/complete` に通った |
 * | `complete_failed`            | 通らなかった。**カルテが表に出ない唯一の経路** |
 *
 * 板書の配送そのもの(`board_opened` / `board_step_rejected` / `board_lesson_overflow` …)は
 * `board.ts` が同じ `JobLogger` に出す。
 */

export type LogFields = Record<string, unknown>;

export type ErrorReporter = (error: unknown, context: LogFields) => void;

/**
 * 縮退の受け皿。**エラーとは別の口にする。**
 *
 * `error` はクラッシュとして `captureException` に流れるが、縮退は
 * 「落ちてはいないが約束が破れている」状態で、混ぜると本当に落ちたものが埋もれる
 * (計画書 §10-7・モバイル側の `telemetry.dart` と同じ切り分け)。
 *
 * どの `warn` を縮退として扱うか・何を伏せるかは `telemetry.ts` が決める。
 * ここは**来たものを渡すだけ**にして、送る条件を触る場所を1つに保つ。
 */
export type DegradationReporter = (event: string, fields: LogFields) => void;

let reporter: ErrorReporter | null = null;
let degradationReporter: DegradationReporter | null = null;

/** Sentryのような受け皿。`index.ts` が(DSNがあれば)差し込む。 */
export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

export function setDegradationReporter(next: DegradationReporter | null): void {
  degradationReporter = next;
}

export class JobLogger {
  // コンストラクタ引数への修飾子(parameter property)は使わない。
  // agentは `node --experimental-strip-types` で .ts を直接動かす(ADR 0002)。
  // 型を消すだけのモードなので、値の生成を伴うこの構文だけは通らない。
  private readonly base: LogFields;
  private readonly sink: (line: string) => void;
  private readonly errorSink: (line: string) => void;

  constructor(
    base: LogFields = {},
    sink: (line: string) => void = console.log,
    errorSink: (line: string) => void = console.error,
  ) {
    this.base = base;
    this.sink = sink;
    this.errorSink = errorSink;
  }

  /** セッション文脈が読めたあと、session_id を全行に足した子を作る。 */
  child(fields: LogFields): JobLogger {
    return new JobLogger({ ...this.base, ...fields }, this.sink, this.errorSink);
  }

  info(event: string, fields: LogFields = {}): void {
    this.sink(this.line("info", event, fields));
  }

  warn(event: string, fields: LogFields = {}): void {
    this.sink(this.line("warn", event, fields));
    // 受け皿が無ければ何もしない(ローカルとテストは常にこちら)。
    degradationReporter?.(event, { ...this.base, ...fields });
  }

  error(event: string, error: unknown, fields: LogFields = {}): void {
    this.errorSink(this.line("error", event, { ...fields, ...describeError(error) }));
    reporter?.(error, { event, ...this.base, ...fields });
  }

  private line(level: string, event: string, fields: LogFields): string {
    return JSON.stringify({
      level,
      event,
      component: "agent",
      ...this.base,
      ...fields,
    });
  }
}

export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(error.stack === undefined ? {} : { error_stack: error.stack }),
    };
  }
  return { error_name: "NonError", error_message: String(error) };
}
