/**
 * エージェントの構造化ログ。
 *
 * ここは**いちばん静かに壊れる場所**。ワーカーが動いていない・ディスパッチが
 * 来ない・カルテのLLMが落ちた、のどれが起きてもアプリからは
 * 「後輩が来ない / カルテが出ない」としか見えない。1行1JSONで、
 * ジョブの節目を必ず残す。
 *
 * | event                  | いつ |
 * | ---------------------- | --- |
 * | `job_started`          | ジョブを受け取った(= ディスパッチは届いている) |
 * | `context_unreadable`   | 文脈が読めない。会話せずに切る |
 * | `conversation_started` | 後輩が最初の一言を出した |
 * | `conversation_ended`   | 終わり方(completed / timeout / user_left / error) |
 * | `karte_built`          | カルテができた(穴の数と所要時間) |
 * | `karte_failed`         | LLMかスキーマで落ちた。空のカルテを送る |
 * | `complete_posted`      | `/complete` に通った |
 * | `complete_failed`      | 通らなかった。**カルテが表に出ない唯一の経路** |
 */

export type LogFields = Record<string, unknown>;

export type ErrorReporter = (error: unknown, context: LogFields) => void;

let reporter: ErrorReporter | null = null;

/** Sentryのような受け皿。`index.ts` が(DSNがあれば)差し込む。 */
export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

export class JobLogger {
  constructor(
    private readonly base: LogFields = {},
    private readonly sink: (line: string) => void = console.log,
    private readonly errorSink: (line: string) => void = console.error,
  ) {}

  /** セッション文脈が読めたあと、session_id を全行に足した子を作る。 */
  child(fields: LogFields): JobLogger {
    return new JobLogger({ ...this.base, ...fields }, this.sink, this.errorSink);
  }

  info(event: string, fields: LogFields = {}): void {
    this.sink(this.line("info", event, fields));
  }

  warn(event: string, fields: LogFields = {}): void {
    this.sink(this.line("warn", event, fields));
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
