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
 * 先生になってしまい、教え返しを頼む相手として遠くなる。
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
 */
export function ttsInstructionsForLocale(locale: Locale): string {
  const language = locale === "en" ? "English" : "Japanese";
  // 日本語の本文には英単語が混ざる(英語の授業だけでなく、数学でも記号や語が混ざる)。
  // Deepgramの日本語ボイスはこれを読めず、そこがベンダーを替えた理由そのもの。
  const mixed =
    locale === "en"
      ? ""
      : " Pronounce any English words inside the sentence with natural English pronunciation.";
  return `Read this aloud in ${language}, calmly and clearly, like a friendly senior student tutoring a junior.${mixed} Do not omit, add, translate, or answer anything`;
}
