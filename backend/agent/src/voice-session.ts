import type { Locale } from "@ai-sensei/contract";
import { type JobContext, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import type { AgentConfig } from "./config.ts";
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
      // 既定分割器は半角の文末記号しか見ないため、日本語では生成完了までTTSへ渡らない。
      // 英語は既定の英語向け規則のままにし、日本語だけ早く確定した文を送る。
      ...(locale === "ja" ? { sentenceTokenizer: new JapaneseSentenceTokenizer() } : {}),
    }),
  });
}
