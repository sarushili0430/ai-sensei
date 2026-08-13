import type { Locale } from "@ai-sensei/contract";
import { type JobContext, inference, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import type { AgentConfig } from "./config.ts";

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

export function createVoiceSession(options: VoiceSessionOptions): voice.AgentSession {
  const { ctx, config, locale, llmTemperature } = options;
  return new voice.AgentSession({
    vad: ctx.proc.userData["vad"] as never,
    // localeはAPIが受け付ける値なので、STTの言語もそれに合わせる。
    // 日本語のモデルのまま英語を流すと、認識が崩れて会話が成立しない。
    stt: new deepgram.STT({
      model: "nova-2-general",
      language: locale,
      interimResults: true,
    }),
    llm: new anthropic.LLM({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.LLM_MODEL_CONVERSATION,
      // 先輩の文体を安定させたいので、振れ幅は小さめにする
      temperature: llmTemperature,
    }),
    // 声は**言語ごとにモデルが分かれる**。1ボイスに言語を渡す作りではないので、
    // localeで選び分ける(日本語ボイスに英語を喋らせることはできない)。
    // SDK 1.6.1 の `TTSModels` は英語ボイスしか型に持たないが、`model` の型は
    // `TTSModels | string` で、実体はAPIへそのまま渡るだけなので日本語ボイスも通る。
    tts: new deepgram.TTS({
      apiKey: config.DEEPGRAM_API_KEY,
      model: locale === "en" ? config.DEEPGRAM_TTS_MODEL_EN : config.DEEPGRAM_TTS_MODEL_JA,
    }),
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
