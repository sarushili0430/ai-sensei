/**
 * 評価ハーネスの環境変数。**`config.ts` の `loadConfig()` は通さない。**
 *
 * あちらは会話中に落ちないよう起動時に LiveKit と Deepgram の鍵まで必須にする。
 * 評価は部屋も音声も使わないので、あれを通すと**板書のプロンプトを測るために
 * 存在しない LiveKit の鍵を用意する**ことになる。鍵は Anthropic の1本だけ。
 *
 * モデル名の既定値は `config.ts` の `LLM_MODEL_*` と**同じ値**にしてある。
 * 評価は本番と同条件で測るためのもので、既定がずれると
 * 「プロンプトを直したのに数字が動いた」の原因がモデル差なのか文面差なのか
 * 切り分けられなくなる。
 */

export type EvalEnv = {
  apiKey: string;
  /** 板書LLM。本番(`LLM_MODEL_BOARD`)と同じ既定。 */
  boardModel: string;
  /** ジャッジ(Stage B)。**採点は生成より上のモデルを充てる。** */
  judgeModel: string;
  /** 生徒シミュレータ(Stage C)。相手役なので安いモデルでよい。 */
  studentModel: string;
  /** カルテ(Stage C)。本番(`LLM_MODEL_KARTE`)と同じ既定。 */
  karteModel: string;
  /** 省略時は各クライアントの既定(`https://api.anthropic.com`)に任せる。 */
  baseUrl?: string;
};

export const evalEnvDefaults = {
  boardModel: "claude-sonnet-5",
  judgeModel: "claude-opus-5",
  studentModel: "claude-haiku-4-5-20251001",
  karteModel: "claude-sonnet-5",
} as const;

/** 鍵が無い・形が違う。CLIはこれを日本語1行で見せて終了する(スタックを出さない)。 */
export class EvalEnvError extends Error {}

/**
 * **空文字は「未設定」として扱う。**`config.ts` の `withDefault` と同じ理由で、
 * `.env` に `EVAL_MODEL_BOARD=` と書くと値は undefined ではなく空文字になる。
 * そのまま流すと起動は通るのに Anthropic 側がモデル名を弾く、という
 * 分かりにくい壊れ方をする。
 */
function withDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? fallback : trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * 実LLMを呼ぶコマンド(`run` / `judge`)の入口で一度だけ読む。
 *
 * `list` からは呼ばない — シナリオ一覧を見るだけで鍵を要求すると、
 * 鍵を持たない環境ではハーネスの中身を確かめる手段が無くなる。
 */
export function loadEvalEnv(env: NodeJS.ProcessEnv = process.env): EvalEnv {
  const apiKey = optional(env["ANTHROPIC_API_KEY"]);
  if (apiKey === undefined) {
    throw new EvalEnvError(
      "ANTHROPIC_API_KEY がありません。backend/agent/.env に入れるか、環境変数で渡してください",
    );
  }

  // 欄そのものを生やさない(`baseUrl: undefined` を渡すと、クライアント側の
  // `?? 既定値` は効くが、レコードやログに空の欄が残って読みにくい)。
  const baseUrl = optional(env["EVAL_ANTHROPIC_BASE_URL"]);

  return {
    apiKey,
    boardModel: withDefault(env["EVAL_MODEL_BOARD"], evalEnvDefaults.boardModel),
    judgeModel: withDefault(env["EVAL_MODEL_JUDGE"], evalEnvDefaults.judgeModel),
    studentModel: withDefault(env["EVAL_MODEL_STUDENT"], evalEnvDefaults.studentModel),
    karteModel: withDefault(env["EVAL_MODEL_KARTE"], evalEnvDefaults.karteModel),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}
