import { z } from "zod";
import { defaultGeminiTtsModel, defaultGeminiTtsVoice } from "./senpai-voice.ts";

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

  /**
   * LiveKitのプロジェクトURL。**中身が空でないかだけでなく、URLとして読めるかまで見る。**
   *
   * スキームが落ちた `example.livekit.cloud` のような値を渡すと、ワーカーの起動中に
   * フレームワーク側の `new URL()` が投げる。その例外は握り潰されていて
   * **`closing worker due to error.` としか出ない**(どの環境変数が悪いのかも、
   * URLの話だということも分からない)。名前を出して落とすためにここで見る。
   */
  LIVEKIT_URL: z
    .string()
    .min(1)
    .refine((value) => URL.canParse(value), "URLとして読めません(wss://... の形で入れる)"),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL_CONVERSATION: withDefault("claude-haiku-4-5-20251001"),
  LLM_MODEL_KARTE: withDefault("claude-sonnet-5"),

  /**
   * 板書を書くモデル(授業モード)。**会話より上のモデルを充てる。**
   *
   * 8/16のゲートは「板書つきで1問教わって『わかる』に到達するか」(計画書 §3-4)で、
   * そこで測られるのは会話の速さではなく**板書の質**。式の割り方(§3-6b)も
   * 許可コマンドの守り方(§3-6)も、外すと授業が止まるか描画が壊れる。
   *
   * 代償はレイテンシで、それは**最初の1手順が出るまでの沈黙**として直に出る。
   * 冒頭は事前生成音声で埋める前提(§3-2)なので、質を採っている。
   * 差し替えるときは `lesson.ts` の `thinking: {type: "disabled"}` を
   * その版が受け付けるかも一緒に確かめること。
   */
  LLM_MODEL_BOARD: withDefault("claude-sonnet-5"),

  /** 聞く(STT)の鍵。喋る側は Gemini へ移したので、ここは STT 専用になった(ADR 0008)。 */
  DEEPGRAM_API_KEY: z.string().min(1),

  /** 喋る(TTS)。Gemini TTS は Gemini API の鍵で通る(ADR 0008)。 */
  GOOGLE_API_KEY: z.string().min(1),

  /**
   * 先輩の声。既定値と選び方の理由は `senpai-voice.ts` にまとめてある。
   *
   * **ここには既定値を書かない。**授業冒頭の同梱音声を作る
   * `scripts/generate-prerendered-audio.ts` も同じ定数を読んでいて、
   * 2箇所に書くと片方だけ古くなり、冒頭の一言だけ別人の声になる。
   *
   * 環境変数で上書きできるのは、モデルを 3.1 へ切り替えるときと、
   * 声を聴き比べるときのため。ローカルと本番で別の声になってはいけないので、
   * 恒久的に変えるなら `senpai-voice.ts` を変えて全環境で一度に変える。
   */
  GEMINI_TTS_MODEL: withDefault(defaultGeminiTtsModel),
  GEMINI_TTS_VOICE: withDefault(defaultGeminiTtsVoice),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // 名前だけでなく理由も出す。「足りない」と「入っているが形が違う」は
    // 直し方がまったく違うのに、名前だけだと見分けがつかない。
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}(${issue.message})`)
      .join(", ");
    throw new Error(`agentの環境変数を読めません: ${detail}(.env.example を参照)`);
  }
  return parsed.data;
}
