/**
 * 何が起きたかを、あとから追えるようにする。
 *
 * Cloudflare Workers の Observability(`wrangler.toml` の `[observability]`)は
 * stdout をそのまま拾う。**1行1JSON**で書いておくと、ダッシュボードや
 * `wrangler tail` でフィールド単位に絞り込める("photo_analysis_failed だけ"
 * "この trace_id だけ")。人が読む用の文字列を混ぜると、そこで検索が切れる。
 *
 * 出すのは3種類だけにする。増やすと、どれを見ればいいのか分からなくなる。
 *
 * | event                | いつ |
 * | -------------------- | --- |
 * | `http_request`       | 全リクエストに1行(結果と所要時間) |
 * | `<何か>_failed`      | 想定内の失敗(写真が読めない・通知の予約に失敗など) |
 * | `unhandled_error`    | 想定外。ユーザーには internal_error を返している |
 *
 * 個人が特定できるものは載せない。デバイスIDは匿名だが端末をまたいで
 * 追える識別子なので、**先頭8文字だけ**にして相関に使えるだけに留める。
 */

export type LogFields = Record<string, unknown>;

export type ErrorReporter = (error: unknown, context: LogFields) => void;

/**
 * Sentryのような外部の受け皿。`index.ts` が(DSNがあれば)差し込む。
 *
 * ここを直接importしないのは、テストとルートの実装を素のままに保つため。
 * 受け皿が無ければ何もしない(ローカル開発でDSNを持たなくても動く)。
 */
let reporter: ErrorReporter | null = null;

export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

/**
 * どこまで出すか。
 *
 * `error` にすると、全リクエストの1行(`http_request`)を落として失敗だけ残す。
 * ログの量が問題になったときの逃げ道で、**既定は info**(何も起きていないことも
 * 見えていないと、遅くなったことに気づけない)。
 */
export type LogLevel = "info" | "error";

export function readLogLevel(env: { LOG_LEVEL?: string } | undefined): LogLevel {
  return env?.LOG_LEVEL === "error" ? "error" : "info";
}

/** 1リクエストぶんの文脈を持つロガー。全行に同じ `trace_id` が入る。 */
export class RequestLogger {
  constructor(
    readonly traceId: string,
    private readonly base: LogFields = {},
    private readonly level: LogLevel = "info",
    private readonly sink: (line: string) => void = console.log,
  ) {}

  info(event: string, fields: LogFields = {}): void {
    if (this.level === "error") return;
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    if (this.level === "error") return;
    this.write("warn", event, fields);
  }

  /**
   * 失敗を1行にする。**スタックはここでしか出ない**ので必ず通す。
   * 外部の受け皿(Sentry)にも同じものを渡す。
   */
  error(event: string, error: unknown, fields: LogFields = {}): void {
    const described = describeError(error);
    this.write("error", event, { ...fields, ...described });
    reporter?.(error, { event, trace_id: this.traceId, ...this.base, ...fields });
  }

  private write(level: string, event: string, fields: LogFields): void {
    this.sink(
      JSON.stringify({
        level,
        event,
        trace_id: this.traceId,
        ...this.base,
        ...fields,
      }),
    );
  }
}

/** エラーを構造化する。Errorでないものを投げられても落ちないようにする。 */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(error.stack === undefined ? {} : { error_stack: error.stack }),
      ...(error.cause === undefined ? {} : { error_cause: String(error.cause) }),
    };
  }
  return { error_name: "NonError", error_message: String(error) };
}

/**
 * デバイスIDの頭だけ。
 *
 * 同じ端末のリクエストを並べて見られれば十分で、全体は要らない。
 */
export function deviceTag(deviceId: string | undefined): string | undefined {
  return deviceId ? deviceId.slice(0, 8) : undefined;
}

/** レスポンスから、アプリに返したエラーコードを拾う(ログの絞り込み用)。 */
export async function errorCodeOf(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;
  if (!response.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } };
    const code = body.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export function newTraceId(): string {
  return crypto.randomUUID();
}
