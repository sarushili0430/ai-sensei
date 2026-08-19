import type { Locale } from "@ai-sensei/contract";
import { toSpeakableJa } from "@ai-sensei/guardrail";
import { type JobContext, inference, tokenize, tts, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as google from "@livekit/agents-plugin-google";
import type { AgentConfig } from "./config.ts";
import { ttsInstructionsForLocale } from "./senpai-voice.ts";
import { JapaneseSentenceTokenizer } from "./sentence-tokenizer.ja.ts";

/**
 * 音声パイプラインの組み立てをここだけに置く。
 *
 * #99 の `ttsTextTransforms`、#101 の `sentenceTokenizer`、#102 の
 * `turnHandling`、STT設定は授業・計画で別々に足すと会話の片方だけが古いまま残る。
 * 効果を比較できるよう、設定を変えるPRはこのファクトリだけを触る。
 */
export type VoiceSessionOptions = {
  ctx: JobContext;
  config: AgentConfig;
  locale: Locale;
  /** 先輩の文体の振れ幅。授業 0.6 / 計画 0.4 — 現状の値をそのまま保つ */
  llmTemperature: number;
};

const incompleteMathTokenPattern = /[A-Za-z0-9^²√∠△:/°≦≧≠≤≥→⇒θπ]+$/u;

/**
 * TTS入力を、数式記号を途中で分断しない単位にしてから日本語の読みへ替える。
 *
 * SDKの変換は任意のチャンク境界で呼ばれるため、`∠` と `ABC` が別チャンクでも
 * 末尾の数式らしい断片を次のチャンクまで保留する。文末まで全量を待つ必要はない。
 */
export function jaSpeakable(text: ReadableStream<string>): ReadableStream<string> {
  let buffer = "";
  return text.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        buffer += chunk;
        const incompleteToken = buffer.match(incompleteMathTokenPattern)?.[0] ?? "";
        const completeText = buffer.slice(0, buffer.length - incompleteToken.length);
        if (completeText !== "") controller.enqueue(toSpeakableJa(completeText));
        buffer = incompleteToken;
      },
      flush(controller) {
        if (buffer !== "") controller.enqueue(toSpeakableJa(buffer));
      },
    }),
  );
}

const defaultTtsTextTransforms = ["filter_markdown", "filter_emoji"] as const;

export function ttsTextTransformsForLocale(locale: Locale) {
  return locale === "ja" ? [...defaultTtsTextTransforms, jaSpeakable] : defaultTtsTextTransforms;
}

/**
 * 先輩の声(Gemini TTS)。ロケールで変わるのは**読み方の指示だけ**で、声は変えない。
 *
 * Deepgram は言語がモデル名に埋まっていて日英で別ボイスだったが、Gemini は
 * 1つの声が両方を喋る(ADR 0008)。日本語の文に混ざった英単語もこの声のまま読む。
 */
export function createGeminiTts(config: AgentConfig, locale: Locale): google.beta.TTS {
  return new google.beta.TTS({
    apiKey: config.GOOGLE_API_KEY,
    model: config.GEMINI_TTS_MODEL,
    voiceName: config.GEMINI_TTS_VOICE,
    instructions: ttsInstructionsForLocale(locale),
  });
}

/**
 * 文分割器。**Gemini TTS はストリーミングを持たないので、ここが実質のTTFB**になる。
 *
 * 分割された1文がそのまま1リクエストなので、句点まで溜めてから投げると
 * その待ちが丸ごと沈黙になる。日本語だけ自前の分割器を当てるのは Deepgram のときと
 * 同じ理由で、SDK既定(`basic`)は半角の文末記号しか見ず「。」で切れない。
 */
export function sentenceTokenizerForLocale(locale: Locale): tokenize.SentenceTokenizer {
  return locale === "ja" ? new JapaneseSentenceTokenizer() : new tokenize.basic.SentenceTokenizer();
}

/**
 * セッションへ渡すTTS。**必ず `StreamAdapter` で包む。**
 *
 * `google.beta.TTS` は `capabilities.streaming === false` で、`stream()` は例外を投げる。
 * 包まずに渡すとSDKが `ttsNode` の中で**既定の `BasicSentenceTokenizer`**で勝手に包む。
 * それは半角の文末記号しか見ないので、日本語は生成が終わるまで1文も投げられず、
 * 授業の最初の一言が丸ごと遅れる。分割器をこちらで選ぶために、包む側もこちらが持つ。
 */
export function createSenpaiTts(config: AgentConfig, locale: Locale): tts.TTS {
  return new tts.StreamAdapter(createGeminiTts(config, locale), sentenceTokenizerForLocale(locale));
}

export function createVoiceSession(options: VoiceSessionOptions): voice.AgentSession {
  const { ctx, config, locale, llmTemperature } = options;
  return new voice.AgentSession({
    vad: ctx.proc.userData["vad"] as never,
    // localeはAPIが受け付ける値なので、STTの言語もそれに合わせる。
    // 日本語のモデルのまま英語を流すと、認識が崩れて会話が成立しない。
    //
    // モデルは `nova-3`。ドッグフーディングの「中々声を聞き取ってくれない」への対応で、
    // `nova-2-general` から上げた。Nova-3 は日本語のモノリンガル(`language=ja`)を
    // ストリーミングで正式にサポートしている(Deepgramのモデル対応表で確認済み)。
    // **`nova-3-general` と書かないこと。**プラグイン(1.6.1)の `#validateModel` は
    // `nova-3-general` を英語以外の言語で `nova-2-general` へ黙って戻すが、
    // `nova-3` はそのままAPIへ通す。同じモデルの別名なのに、名前で挙動が分かれる。
    stt: new deepgram.STT({
      model: "nova-3",
      language: locale,
      interimResults: true,
    }),
    llm: new anthropic.LLM({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.LLM_MODEL_CONVERSATION,
      // 先輩の文体を安定させたいので、振れ幅は小さめにする
      temperature: llmTemperature,
    }),
    // 声は**日英で同じ1つ**。Gemini のボイスは言語を選ばないので、日本語の文に
    // 英単語が混ざってもそのまま読む(ADR 0008)。組み立ては `createSenpaiTts`。
    tts: createSenpaiTts(config, locale),
    // LiveKit SDK 1.6.1 の `voice/agent_activity.ts` は会話・`session.say()` とも先に `tee()` し、
    // TTS枝だけへ `performTTSInference` 内でこの変換を適用する。字幕枝は元の文字列のまま流れる。
    // 既定値も明示しないと自作変換を渡した時点でMarkdown・絵文字の除去が消える。
    ttsTextTransforms: ttsTextTransformsForLocale(locale),
    turnHandling: {
      // `turn-detector-v1-mini` は日本語(ja)対応のローカルEOTモデル。モデル本体は
      // `@livekit/local-inference` のOS別ネイティブ依存に同梱され、Workerが共有の
      // inference processへ自動登録して起動時に読む。未指定でもSDKはdetectorを自動生成するが、
      // hosted/dev環境では`v1`、それ以外では`v1-mini`を選ぶため、版を固定して#103の
      // `eou_delay_ms`を環境差なく比較する。ネットワーク往復とInference課金も避けられる。
      // 小さい`v1-mini`は`v1`より精度が落ちうる上に、コンテナのCPUを使う。精度が足りなければ
      // #103のメトリクスを見てから`v1`へ上げる。
      turnDetection: new inference.TurnDetector({ version: "v1-mini" }),
      // `resolveEndpointing`は部分指定を既定へ併合するため、`fixed / minDelay: 300ms`を残して
      // maxDelayだけを4秒にする。EOTが終わりと判定したときはminDelayだけ待ち、まだ話すと
      // 判定したときはmaxDelayへ切り替わる（加算ではない）。教え返しで考える時間は3秒超を
      // 確保しつつ、速く返せる場面まで遅くしない。
      endpointing: { maxDelay: 4_000 },
      interruption: {
        // adaptiveは重なり音声をクラウドへ送るため、未成年の会話内容を外へ出さない方針から
        // 今回は指定しない。ローカルのVADベース検出を使う。
        // 咳や短い生活音で授業を切らず、実際に話し始めた生徒は止められるよう、
        // 推奨範囲700〜1000msの中間寄りである800msまで確認する。
        minDuration: 800,
        // `minWords` は既定の0のままにする。SDKの語数カウントは空白区切りの英語前提で、
        // 日本語は1発話が常に1語になるため、値を上げると生徒の割り込みを検出できない。
      },
    },
  });
}
