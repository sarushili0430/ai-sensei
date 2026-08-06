import { z } from "zod";

/** agentの環境変数。起動時に一度だけ検証する(会話中に落ちないように)。 */
const configSchema = z.object({
  API_BASE_URL: z.string().url(),
  INTERNAL_API_TOKEN: z.string().min(1),

  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL_CONVERSATION: z.string().default("claude-haiku-4-5-20251001"),
  LLM_MODEL_KARTE: z.string().default("claude-sonnet-5"),

  /** 聞く(STT)と喋る(TTS)は同じ鍵で通る。声のベンダーは1つに寄せてある(ADR 0003)。 */
  DEEPGRAM_API_KEY: z.string().min(1),

  /**
   * 後輩の声(日本語)。`aura-2-<voice>-ja` の形で、Deepgramのボイス一覧から選ぶ。
   *
   * **既定値は置かない。** 声はキャラクターそのものなので、選ばないまま
   * 適当なボイスで喋り出すより、起動時に「選べ」と言われるほうがいい。
   */
  DEEPGRAM_TTS_MODEL_JA: z.string().min(1),

  /**
   * 英語ロケールの声。
   *
   * Deepgramは**言語がモデル名に埋まっている**ので、日本語ボイスは英語を喋れない
   * (1ボイスに言語を渡す作りではない)。`locale=en` はデモと審査向けなので、
   * 既定のまま動けばよく、こだわるときだけ差し替える。
   */
  DEEPGRAM_TTS_MODEL_EN: z.string().default("aura-2-andromeda-en"),
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
