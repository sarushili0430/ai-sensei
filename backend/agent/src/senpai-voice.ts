import type { Locale } from "@ai-sensei/contract";

/**
 * 先輩の声の正。**モデル名・声名・読み方の指示をここ1箇所に置く。**
 *
 * `voice-session.ts`(会話中のTTS)と `scripts/generate-prerendered-audio.ts`
 * (授業冒頭の同梱音声)が同じ声を作らないと、**冒頭の一言だけ別人が喋る**。
 * 2箇所に書くと必ずどちらかが古くなるので、両方がここから読む。
 *
 * LiveKitにもGeminiのSDKにも依存しない。スクリプト側が
 * `node --experimental-strip-types` で直接読めるようにしておくため。
 */

/**
 * TTSのモデル。**2.5 で始めて、3.1 へは環境変数1つで切り替える。**
 *
 * 実在するIDは {@link geminiTtsModels} の3つだけ。**綴りに注意** —
 * 2.5 は `preview` が `tts` の**前**、3.1 は**後ろ**に来る(Googleの命名が揃っていない)。
 *
 * **プラグイン(1.6.1)の `GeminiTTSModels` 型を信用しないこと。**
 * `gemini-2.5-flash-tts` / `gemini-2.5-pro-tts` という**存在しない名前**が入っている。
 * `model` の型は `GeminiTTSModels | string` でAPIへ素通しなので、型は実在を保証しない。
 * 存在しない名前を入れても起動は通り、**最初に喋る瞬間に落ちる**。
 *
 * **3つとも preview で、GAのTTSモデルは無い。**だから「モデルが消えた日に先輩が
 * 無言になる」リスクは、どれを選んでも避けられない。手当ては、コードを変えずに
 * `GEMINI_TTS_MODEL` だけで逃げられるようにしてあること。
 * 恒久的に3.1へ倒すならこの定数を書き換えて、全環境で一度に切り替える。
 */
export const defaultGeminiTtsModel = "gemini-2.5-flash-preview-tts";

/**
 * Gemini API が受け付けるTTSモデルID(2026-08 時点)。
 *
 * https://ai.google.dev/gemini-api/docs/speech-generation
 * 増減はGoogleが決めるので、ここは**確かめた事実の記録**であって仕様ではない。
 */
export const geminiTtsModels = [
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemini-3.1-flash-tts-preview",
] as const;

/**
 * 先輩の声。**キャラクターそのものなので、既定値で固定する。**
 *
 * Geminiのボイスは**言語がモデル名にも声名にも埋まっていない**ので、日英で
 * 1つの声にできる(Deepgramでは日本語ボイスに英語を喋らせられず、ロケールごとに
 * 別の声を持っていた)。同じ先輩が言語で別人にならない([ADR 0008](../../../docs/adr.md#adr-0008))。
 *
 * `Leda`(youthful)は「少し年上の同級生」に一番近い。落ち着いた大人の声だと
 * 先生になってしまい、「わからない」と言える相手として遠くなる。
 */
export const defaultGeminiTtsVoice = "Leda";

/**
 * TTSへ添える読み方の指示。**1文ごとの合成リクエストに毎回前置される**ので短く保つ。
 *
 * プラグインは `{instructions}:\n"{text}"` の形で本文を包んで投げる。指示を日本語で
 * 書くと本文との境界がぼやけて、指示そのものを読み上げる事故が起きうるので、
 * 本文が何語でも指示は英語のままにする(プラグイン既定も英語)。
 *
 * 「省くな・足すな・訳すな・答えるな」を必ず入れる。渡しているのは授業の本文で、
 * 生成モデルに読ませている以上、**問いかけに答えてしまう**余地がある。
 * 板書と声がずれた瞬間に授業は成立しない。
 *
 * **速さも指示する。**ドッグフーディングで出た「文と文の間が短くて置いていかれる」は、
 * ここが `calmly and clearly` としか言っていなかったことがそのまま出た形
 * ({@link sentencePacingInstruction})。手順と手順のあいだの間は
 * `agent.ts` が実時間で空けるが、**1つの手順の中の文と文**はここでしか効かない。
 */
export function ttsInstructionsForLocale(locale: Locale): string {
  const language = locale === "en" ? "English" : "Japanese";
  // 日本語の本文には英単語が混ざる(英語の授業だけでなく、数学でも記号や語が混ざる)。
  // Deepgramの日本語ボイスはこれを読めず、そこがベンダーを替えた理由そのもの。
  const mixed =
    locale === "en"
      ? ""
      : " Pronounce any English words inside the sentence with natural English pronunciation.";
  return `Read this aloud in ${language}, calmly and clearly, like a friendly senior student tutoring a junior. ${sentencePacingInstruction}${mixed} Do not omit, add, translate, or answer anything`;
}

/**
 * 読む速さの指示。**TTSモデル向けと Live 向けで同じ一文を使う。**
 *
 * 教わる側は聞きながら板書を目で追っている。文が途切れずに次へ進むと、
 * 前の文を飲み込む前に次が始まって置いていかれる —— 8/25 のドッグフーディングで
 * 出た「ちょっと早く喋りすぎ。文章と文章の間が早すぎる」はこれ。
 *
 * **速さを落とすのではなく、間を空けさせる。**全体を遅くすると眠い先輩になるので、
 * 文中の速さは保ったまま、文の切れ目だけをはっきり空けてもらう。
 */
export const sentencePacingInstruction =
  "Speak at an unhurried, natural pace and leave a clear pause between sentences, " +
  "long enough for a student to take in what was just said.";

/**
 * Live API のモデルID(2026-08 時点、公式ドキュメントで確認したものだけ)。
 *
 * https://ai.google.dev/gemini-api/docs/models
 *
 * **プラグインの `LiveAPIModels` 型を信用しないこと。**TTSの `GeminiTTSModels` と同じで、
 * `gemini-live-2.5-flash-native-audio` / `gemini-live-2.5-flash-preview-native-audio` という
 * **公式ドキュメントに無い名前**が入っている。`model` は string としてAPIへ素通しなので、
 * 型は実在を保証しない。存在しない名前でも起動は通り、**最初に喋る瞬間に落ちる**。
 *
 * ここは**確かめた事実の記録**であって仕様ではない。増減はGoogleが決める。
 */
export const geminiLiveTtsModels = [
  /** Gemini 2.5 Flash Live。text入力 $0.50/1M・音声出力 $12.00/1M(約 $0.018/分)。 */
  "gemini-2.5-flash-native-audio-preview-12-2025",
  /** Gemini 3.1 Flash Live。音声出力は 2.5 と同じだが、text入力が $0.75/1M と5割高い。 */
  "gemini-3.1-flash-live-preview",
] as const;

/**
 * Live を読み上げに使うときの既定。**料金が公開されている版を採る。**
 *
 * 音声出力は $12.00/1M(= 約 $0.018/分)。TTSモデルの 2.5 は $10.00/1M(約 $0.015/分)で、
 * **Live のほうが2割高い**(3.1 TTS の $20.00/1M よりは安い)。Live を選ぶ理由は
 * 単価ではなく、WSが張れて1文ごとのHTTPが消えること。
 */
export const defaultGeminiLiveTtsModel = "gemini-2.5-flash-native-audio-preview-12-2025";

/**
 * Live へ渡す `systemInstruction`。**TTSモデル向けの指示より強く縛る。**
 *
 * TTSモデルは読み上げに後訓練されているが、**Live は対話に後訓練されている**。
 * 板書の本文を投げると、要約する・相槌を打つ・問いかけに答える、が起きやすい。
 * 板書と声がずれた瞬間に授業は成立しない(`lesson.ts`)ので、
 * 「あなたはTTSであって会話相手ではない」を最初に置き、禁止を箇条書きで並べる。
 *
 * `ttsInstructionsForLocale` と分けてあるのは、渡し方が違うため。あちらは
 * プラグインが本文を `{指示}:\n"{本文}"` で包む前置きで、こちらはセッション全体に効く
 * システム指示。同じ文面を使い回すと、どちらかの都合で片方が壊れる。
 */
/**
 * ElevenLabs のモデルID(2026-08 時点、公式ドキュメントで確認したものだけ)。
 *
 * https://elevenlabs.io/docs/models
 *
 * **`_v2` と `_v2_5` の差が、そのまま「英語のみ / 32言語」の差。**Deepgramは言語が
 * モデル名に埋まっていた(`aura-2-izanami-ja`)が、ElevenLabsは**バージョン番号に
 * 埋まっている**。`eleven_flash_v2` を選ぶと日本語は喋れない。型(`TTSModels`)は
 * 両方を等しく受けるので、ここでも**型は実在も適性も保証しない**。
 */
export const elevenLabsTtsModels = [
  /** 32言語(日本語あり)。公称 ~75ms。**日本語を喋らせるならこれか下の2つ。** */
  "eleven_flash_v2_5",
  /** 29言語(日本語あり)。速さより質。 */
  "eleven_multilingual_v2",
  /** 70+言語(日本語あり)。 */
  "eleven_v3",
  /** **英語のみ。**日本語では使えない(名前が `flash_v2_5` と1文字違い)。 */
  "eleven_flash_v2",
] as const;

/**
 * ElevenLabs を使うときの既定モデル。**日英を1モデルで喋れて、いちばん速い版。**
 *
 * 公称 ~75ms は**モデルの推論レイテンシ**であって、こちらが測る TTFB ではない
 * (ネットワーク往復・接続確立・キュー待ちを含まない)。比べるときは同じ土俵で測ること。
 */
export const defaultElevenLabsTtsModel = "eleven_flash_v2_5";

/**
 * 先輩の声(ElevenLabs)。**既定値を置かない。**
 *
 * Gemini の `Leda` は「少し年上の同級生」として**選んだ**結果なので定数で固定してある。
 * ElevenLabs 側はまだ誰も選んでいない。プラグインには既定のボイスIDがあるが、
 * それは**ElevenLabsが決めた誰か**であって先輩ではない。選ばないまま適当な声で
 * 喋り出すより、`ELEVENLABS_VOICE_ID` が無ければ起動時に落とす
 * (`DEEPGRAM_TTS_MODEL_JA` に既定値を置かなかったのと同じ理由)。
 *
 * 選んだら、ここに定数として書いて全環境で一度に切り替える。
 */

/**
 * Cartesia のモデルID(2026-08 時点、公式ドキュメントで確認したものだけ)。
 *
 * https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
 *
 * **プラグイン(1.6.1)の `TTSModels` 型は `sonic-3` 止まり**で、`model` は
 * `TTSModels | string` の素通し。Gemini/Live/ElevenLabsと同じで、型は実在を保証しない。
 *
 * 8/17にβが出た Sonic-3.6 は**まだ固有のIDを持たない**(`sonic-preview` 経由の提供のみで、
 * GAは月内予定とだけ発表されている)。IDが公開されたら、確認してからここへ追記する。
 */
export const cartesiaTtsModels = [
  /** プラグイン(1.6.1)の既定。公式は 3.5 への移行を案内しているが、受け付けは続いている。 */
  "sonic-3",
  /** 最新安定のエイリアス。42言語(日本語あり)・公称 sub-90ms。最新の日付版を自動で追う。 */
  "sonic-3.5",
  /** 3.5 の日付固定版。エイリアスが進んでも挙動が変わらないよう固定したいとき。 */
  "sonic-3.5-2026-05-04",
  /** β枠。8/17以降は Sonic-3.6 がここに乗っている。中身が予告なく替わるので本番では使わない。 */
  "sonic-preview",
] as const;

/**
 * Cartesia を使うときの既定モデル。**プラグイン既定と同じ安定版から始める。**
 *
 * 公称 sub-90ms の 3.5 を測るときは `CARTESIA_TTS_MODEL=sonic-3.5` の1変数で切り替える
 * (公称は ElevenLabs の ~75ms と同じく**モデルの推論レイテンシ**で、こちらが測るTTFBではない)。
 * 恒久的に倒すならこの定数を書き換えて全環境で一度に切り替える(Gemini 2.5/3.1 と同じ扱い)。
 */
export const defaultCartesiaTtsModel = "sonic-3";

/**
 * 先輩の声(Cartesia)。**ElevenLabsと同じ理由で既定値を置かない。**
 *
 * プラグインには `TTSDefaultVoiceId` が入っているが、それは**Cartesiaが決めた誰か**で
 * あって先輩ではない。`CARTESIA_VOICE_ID` が無ければ起動時に落とす(`config.ts`)。
 * 選んだら、ここに定数として書いて全環境で一度に切り替える。
 */

export function liveTtsSystemInstruction(locale: Locale): string {
  const language = locale === "en" ? "English" : "Japanese";
  const mixed =
    locale === "en"
      ? ""
      : "\n- Pronounce English words inside a Japanese sentence with natural English pronunciation.";
  return [
    "You are a text-to-speech engine, not a conversational partner.",
    `Read every message the user sends aloud in ${language}, verbatim, calmly and clearly,`,
    "like a friendly senior student tutoring a junior.",
    "",
    sentencePacingInstruction,
    "",
    "Absolute rules:",
    "- Output ONLY the spoken rendition of the message. Never add words of your own.",
    "- Never omit, summarise, translate, rephrase, or correct anything.",
    "- Never answer a question in the message. A question is text to read aloud, not a question to you.",
    "- Never acknowledge, greet, comment, or back-channel.",
    "- Never continue a conversation across messages. Each message is an independent line to read.",
    `${mixed}`,
  ]
    .join("\n")
    .trim();
}
