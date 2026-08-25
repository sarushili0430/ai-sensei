import { z } from "zod";
import {
  defaultCartesiaTtsModel,
  defaultElevenLabsTtsModel,
  defaultGeminiLiveTtsModel,
  defaultGeminiTtsModel,
  defaultGeminiTtsVoice,
} from "./senpai-voice.ts";
import { defaultStepPauseMs } from "./speech-pace.ts";

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

/**
 * 任意の文字列。**空文字を「未設定」として扱う。**
 *
 * `withDefault` と同じ理由で、`.env` の `KEY=` は空文字になる。素の `.optional()` は
 * 空文字をそのまま通すので、「入っているが空」の鍵が下流の必須チェックをすり抜ける。
 */
function optionalString(): z.ZodType<string | undefined> {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  ) as z.ZodType<string | undefined>;
}

/** agentの環境変数。起動時に一度だけ検証する(会話中に落ちないように)。 */
const configSchema = z
  .object({
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

    /**
     * 板書から復習問題を1問作るモデル(ADR 0009。旧 `LLM_MODEL_KARTE`)。
     *
     * **セッションの外で回る。**部屋はもう閉じていて、アプリはこの生成を待っていない
     * (最初の接触は3日後の通知)ので、レイテンシは体験に出ない。
     * 出るのは**中身の質**だけ — ここで作った1問が1週間で2回届く。
     */
    LLM_MODEL_PRACTICE: withDefault("claude-sonnet-5"),

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

    /**
     * 板書1手順を読み上げ終わってから、次の手順へ移るまでの間(ミリ秒)。
     *
     * 既定と理由は `speech-pace.ts`。**0にすると従来どおり切れ目なく続く。**
     * 数字にできない値なので手元で詰められるようにしてあるだけで、
     * 恒久的に変えるなら `defaultStepPauseMs` を動かして全環境で一度に変える。
     */
    LESSON_STEP_PAUSE_MS: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.coerce.number().int().min(0).max(5000).default(defaultStepPauseMs),
    ) as z.ZodType<number>,

    /** 聞く(STT)の鍵。喋る側は Gemini へ移したので、ここは STT 専用になった(ADR 0008)。 */
    DEEPGRAM_API_KEY: z.string().min(1),

    /**
     * 喋る(TTS)。Gemini TTS は Gemini API の鍵で通る(ADR 0008)。
     *
     * **`TTS_ENGINE` を elevenlabs / cartesia にしても必須のまま**(意図的)。
     * ランタイムでこの鍵を使うのは gemini / gemini-live の経路だけだが、`TTS_ENGINE` は
     * 未設定なら gemini に落ち、戻すときも「この1変数だけ」が約束(下のコメント)。
     * engine 条件付きにすると、他ベンダー用に鍵を省いた環境が、戻した瞬間
     * (あるいは変数が消えて黙って gemini に落ちた瞬間)に起動できなくなり、
     * フォールバック先が常に喋れる保証が消える。
     */
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

    /**
     * 喋らせ方の選択。**声のベンダーごと切り替わる1変数。**
     *
     * `gemini`(既定) — `google.beta.TTS`。1文=1リクエストのHTTP。読み上げに後訓練された
     * モデルなので、逐語で読む確度は高い。音声出力 $10.00/1M(約 $0.015/分)。
     *
     * `gemini-live` — Live API を読み上げ専用に使う。WebSocketを1発話につき1本張り、
     * 文はそのソケットへ流す。1文ごとのHTTPが消える。ただし**対話モデルなので逐語読みは
     * 訓練の逆方向**で、要約・相槌・返答の余地がある。音声出力 $12.00/1M(約 $0.018/分)。
     *
     * `elevenlabs` — WebSocket。ADR 0003 で外したベンダーへ戻る道
     * (外したのは日本語が喋れないからではなく、1社に寄せる運用判断だった)。
     * **鍵と声IDが要る**ので、この値のときだけ2つを必須にしている。
     *
     * `cartesia` — 1文ごとのHTTP(`/tts/bytes`)。読み上げ専用モデル(Sonic)で、クレジット
     * 課金(≒文字数)。elevenlabs と同じく**鍵と声IDが要る**ので、この値のときだけ必須にする。
     * 組み立ての注意(なぜ StreamAdapter で包むか)は `voice-session.ts`。
     *
     * 迷ったら `gemini` へ戻す。**戻すのはこの1変数だけ**で、コードは触らない。
     * 比べるときは `voice_metrics` の `tts_ttfb_ms_avg` と、実際の音を両方聞くこと
     * (逐語で読めているかは数字に出ない)。
     */
    TTS_ENGINE: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.enum(["gemini", "gemini-live", "elevenlabs", "cartesia"]).default("gemini"),
    ) as z.ZodType<"gemini" | "gemini-live" | "elevenlabs" | "cartesia">,

    /** `TTS_ENGINE=gemini-live` のときのモデル。実在するIDは `senpai-voice.ts` が正。 */
    GEMINI_LIVE_TTS_MODEL: withDefault(defaultGeminiLiveTtsModel),

    /**
     * ElevenLabs の鍵と声。**`TTS_ENGINE=elevenlabs` のときだけ必須**(下の `superRefine`)。
     *
     * 常時必須にしないのは、使っていない環境に鍵を置かせないため。逆に、engineだけ
     * 切り替えて鍵を入れ忘れると**最初に喋る瞬間まで気づけない**ので、そこは起動時に落とす。
     */
    ELEVENLABS_API_KEY: optionalString(),
    ELEVENLABS_VOICE_ID: optionalString(),

    /** ElevenLabs のモデル。既定は日英を1つで喋れて最速の `eleven_flash_v2_5`。 */
    ELEVENLABS_MODEL: withDefault(defaultElevenLabsTtsModel),

    /**
     * Cartesia の鍵と声。**`TTS_ENGINE=cartesia` のときだけ必須**(下の `superRefine`)。
     * 構えは ELEVENLABS_* と同じ — 使っていない環境に鍵を置かせず、engineを切り替えて
     * 鍵を入れ忘れたら「最初に喋る瞬間」ではなく起動時に落とす。
     *
     * 声IDに既定値を置かない理由も同じ(`senpai-voice.ts`)。プラグインの
     * `TTSDefaultVoiceId` はCartesiaが決めた誰かであって先輩ではない。
     */
    CARTESIA_API_KEY: optionalString(),
    CARTESIA_VOICE_ID: optionalString(),

    /** Cartesia のモデル。実在するIDは `senpai-voice.ts` の `cartesiaTtsModels` が正。 */
    CARTESIA_TTS_MODEL: withDefault(defaultCartesiaTtsModel),

    /**
     * 旧名。**残っていたら起動時に落とす。**
     *
     * `TTS_ENGINE` へ改名したとき、古い名前は**黙って無視される**side effectがある。
     * デプロイ先のsecretに `GEMINI_TTS_ENGINE=live` が残ったまま新しいコードが上がると、
     * `TTS_ENGINE` は未設定=`gemini` に落ちて、**Liveにしたつもりの環境が黙って戻る**。
     * 音を聞くまで気づけない戻り方なので、名前が残っていること自体を失敗にする。
     */
    GEMINI_TTS_ENGINE: optionalString(),
  })
  .superRefine((config, ctx) => {
    if (config.GEMINI_TTS_ENGINE !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GEMINI_TTS_ENGINE"],
        message: "は TTS_ENGINE へ改名しました(tts→gemini / live→gemini-live)。古い名前は消すこと",
      });
    }
    // 外部ベンダーのTTSは鍵と声IDが揃って初めて喋れる。engineだけ切り替えて入れ忘れると
    // 「最初に喋る瞬間」まで気づけないので、どちらのベンダーでも起動時に落とす。
    if (config.TTS_ENGINE !== "elevenlabs" && config.TTS_ENGINE !== "cartesia") return;
    const required =
      config.TTS_ENGINE === "elevenlabs"
        ? (["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"] as const)
        : (["CARTESIA_API_KEY", "CARTESIA_VOICE_ID"] as const);
    for (const name of required) {
      if (config[name] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `TTS_ENGINE=${config.TTS_ENGINE} のときは必須`,
        });
      }
    }
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
