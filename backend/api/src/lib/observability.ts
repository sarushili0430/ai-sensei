/**
 * 何が起きたかを、あとから追えるようにする。
 *
 * Cloudflare Workers の Observability(`wrangler.toml` の `[observability]`)は
 * stdout をそのまま拾う。**1行1JSON**で書いておくと、ダッシュボードや
 * `wrangler tail` でフィールド単位に絞り込める("photo_analysis_failed だけ"
 * "この trace_id だけ")。人が読む用の文字列を混ぜると、そこで検索が切れる。
 *
 * 出すのは4種類だけにする。増やすと、どれを見ればいいのか分からなくなる。
 *
 * | event                | いつ |
 * | -------------------- | --- |
 * | `http_request`       | 全リクエストに1行(結果と所要時間) |
 * | `study_room_visit`   | 自習室の退室イベントに1行(日次合計を含む) |
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
 * **縮退**の受け皿。エラーとは別の口にする(計画書 §10-7)。
 *
 * `error` はクラッシュとして `captureException` に流れる。こちらは
 * 「落ちてはいないが約束が破れている」状態で、`captureMessage(level: "warning")` へ送る。
 * 混ぜると本当に落ちたものが埋もれる。モバイル側・agent 側と同じ切り分け。
 */
export type DegradationReporter = (event: string, fields: LogFields) => void;

let degradationReporter: DegradationReporter | null = null;

export function setDegradationReporter(next: DegradationReporter | null): void {
  degradationReporter = next;
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

  /**
   * **縮退の通報は `LOG_LEVEL` で止めない。**
   *
   * `level: "error"` は**標準出力の量**を落とすための逃げ道で、
   * 「気づかなくてよい」という意味ではない。ここで一緒に黙らせると、
   * ログが多いという理由で監視まで切れる — しかも切れたことに気づく手段がない。
   */
  warn(event: string, fields: LogFields = {}): void {
    // 受け皿が無ければ何もしない(ローカルとテストは常にこちら)。
    degradationReporter?.(event, { trace_id: this.traceId, ...this.base, ...fields });
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

/* -------------------------------------------------------------------------- */
/* 縮退(warn のうち、監視に上げるもの)                                        */
/* -------------------------------------------------------------------------- */

/**
 * 監視に上げる縮退。**閉じた集合にする。**
 *
 * `warn` を全部上げると、認証の弾き(スキャナが常時叩く)まで飛んで
 * **アラート疲れ**になる。入れる基準は「**ユーザーが損をしたか**」の1つ。
 *
 * agent 側(`backend/agent/src/telemetry.ts`)と**同じ考え方だが、別の実装**。
 * ランタイムもSDKも違う(`@sentry/node` / `@sentry/cloudflare`)ので、
 * 共有パッケージにはしていない。**揃えるのは方針**(縮退はwarning・本文は送らない・
 * 鍵が無ければ何もしない)であって、コードではない。
 */
export const apiDegradations = [
  /**
   * ノートの写真が読めなかった。手がかりゼロで授業が始まる。
   * ここが増え続けるなら、撮影のガイドか解析のどちらかが効いていない。
   */
  "notes_photo_unreadable",
  /**
   * 問題の写真が読めなかった。**先輩は問題を見ないまま教える**ことになり、
   * 「問題、読んでもらってもいい?」から始まる(計画書 §4-1)。
   */
  "problem_photo_unreadable",
  /**
   * カルテのLLMが許可リスト外のtopic_idを付け、こちらで付け替えた。
   * 復習の通知が的外れになる方向の劣化で、**画面上は何事もなく進む**。
   */
  "guardrail_retagged_holes",
] as const;

export type ApiDegradation = (typeof apiDegradations)[number];

const degradationSet = new Set<string>(apiDegradations);

export function isDegradation(event: string): event is ApiDegradation {
  return degradationSet.has(event);
}

/**
 * 監視に送ってよい欄。**ここに無い文字列は落とす(deny ではなく allow)。**
 *
 * ログの欄は今後も増えるので、「危ないものを列挙して落とす」形だと
 * 足された欄が既定で送られてしまう。既定は落とす側に倒す。
 */
export const degradationStringFields = [
  "trace_id",
  "session_id",
  "kind",
  "locale",
  /** カリキュラムの閉じた語彙(`packages/curriculum` のID)。ユーザーの入力ではない。 */
  "retagged_to",
] as const;

const allowedStrings = new Set<string>(degradationStringFields);

/** 送る直前に本文を落とす最後の関門。数値・真偽値は通し、文字列は許可リストのみ。 */
export function scrubFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string" && allowedStrings.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 同じことを何度も送らないための間引き。
 *
 * Workers は**リクエストごとにアイソレートが使い回される**ので、状態はプロセス内に
 * 溜まる。上限に達したら全部忘れる(送りすぎより「長く生きたアイソレートからは
 * 何も飛ばなくなる」ほうが困る)。
 */
export class DegradationThrottle {
  private readonly limit: number;
  private readonly seen = new Set<string>();

  constructor(limit = 64) {
    this.limit = limit;
  }

  allow(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.limit) this.seen.clear();
    this.seen.add(key);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

/** 「同じ出来事」の単位。セッション単位で1件だけ送る。 */
export function degradationKey(event: string, fields: LogFields): string {
  const scope = fields["session_id"];
  return `${event}/${typeof scope === "string" ? scope : ""}`;
}

export type CaptureDegradation = (event: ApiDegradation, fields: LogFields) => void;

/**
 * `RequestLogger.warn` を受けて、縮退だけを間引いて送る関数を作る。
 * 判定・間引き・伏せ字をここに集めるので、`index.ts` は差し込むだけでよい。
 */
export function createDegradationReporter(
  capture: CaptureDegradation,
  throttle: DegradationThrottle = new DegradationThrottle(),
): DegradationReporter {
  return (event, fields) => {
    if (!isDegradation(event)) return;
    if (!throttle.allow(degradationKey(event, fields))) return;
    capture(event, scrubFields(fields));
  };
}
