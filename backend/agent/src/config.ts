import { z } from "zod";

/**
 * 既定値のある設定。**空文字を「未設定」として扱う。**
 *
 * `.env` に `KEY=` と書くと、値は undefined ではなく空文字になる。
 * 素の `z.string().default()` は undefined のときしか既定値を入れないので、
 * 空文字がそのまま下流(モデル名など)へ流れて、起動は通るのに
 * APIが弾く、という分かりにくい壊れ方をする。ここで吸収しておく。
 */
function withDefault(fallback: string): z.ZodType<string> {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().default(fallback),
  ) as z.ZodType<string>;
}

/** agentの環境変数。起動時に一度だけ検証する(会話中に落ちないように)。 */
const configSchema = z.object({
  API_BASE_URL: z.string().url(),
  INTERNAL_API_TOKEN: z.string().min(1),

  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL_CONVERSATION: withDefault("claude-haiku-4-5-20251001"),
  LLM_MODEL_KARTE: withDefault("claude-sonnet-5"),

  /** 聞く(STT)と喋る(TTS)は同じ鍵で通る。声のベンダーは1つに寄せてある(ADR 0003)。 */
  DEEPGRAM_API_KEY: z.string().min(1),

  /**
   * 後輩の声(日本語)。**キャラクターそのものなので、既定値で固定する。**
   *
   * 環境変数で上書きできるのは声を聴き比べるときのため。ローカルと本番で
   * 別の声になってはいけない(同じ後輩が環境ごとに違う声で喋ることになる)ので、
   * 差し替えるならここを変えて、全環境で一度に変える。
   */
  DEEPGRAM_TTS_MODEL_JA: withDefault("aura-2-izanami-ja"),

  /**
   * 英語ロケールの声。
   *
   * Deepgramは**言語がモデル名に埋まっている**ので、日本語ボイスは英語を喋れない
   * (1ボイスに言語を渡す作りではない)。`locale=en` はデモと審査向けなので、
   * 既定のまま動けばよく、こだわるときだけ差し替える。
   */
  DEEPGRAM_TTS_MODEL_EN: withDefault("aura-2-andromeda-en"),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`agentの環境変数が足りません: ${missing}(.env.example を参照)`);
  }
  return parsed.data;
}
