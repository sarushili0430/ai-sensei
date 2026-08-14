import type { Locale } from "@ai-sensei/contract";
import { toSpeakableJa } from "@ai-sensei/guardrail";
import { type JobContext, inference, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import type { AgentConfig } from "./config.ts";
import { JapaneseSentenceTokenizer } from "./sentence-tokenizer.ja.ts";

/**
 * The one place the voice pipeline is assembled.
 *
 * Adding #99's `ttsTextTransforms`, #101's `sentenceTokenizer`, #102's
 * `turnHandling` and the STT config separately for lessons and planning leaves
 * one of the two conversations stale. So the settings can be compared, PRs that
 * change them touch only this factory.
 */
export type VoiceSessionOptions = {
  ctx: JobContext;
  config: AgentConfig;
  locale: Locale;
  /** How much the senpai's tone may vary. Lesson 0.6 / plan 0.4 - keep as-is. */
  llmTemperature: number;
};

const incompleteMathTokenPattern = /[A-Za-z0-9^²√∠△:/°≦≧≠≤≥→⇒θπ]+$/u;

/**
 * Chunk TTS input so math symbols are never split, then map to Japanese readings.
 *
 * The SDK calls the transform on arbitrary chunk boundaries, so a trailing
 * math-looking fragment is held back for the next chunk even when `∠` and `ABC`
 * arrive separately. No need to wait for the whole sentence.
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

export function createVoiceSession(options: VoiceSessionOptions): voice.AgentSession {
  const { ctx, config, locale, llmTemperature } = options;
  return new voice.AgentSession({
    vad: ctx.proc.userData["vad"] as never,
    // The locale is an API-accepted value, so STT follows it. Feeding English to
    // the Japanese model wrecks recognition and the conversation falls apart.
    stt: new deepgram.STT({
      model: "nova-2-general",
      language: locale,
      interimResults: true,
    }),
    llm: new anthropic.LLM({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.LLM_MODEL_CONVERSATION,
      // Keep the senpai's tone stable, so keep variance low.
      temperature: llmTemperature,
    }),
    // Voices are split *per language*; a single voice does not take a language
    // argument, so pick by locale (a Japanese voice cannot speak English).
    // SDK 1.6.1's `TTSModels` types only English voices, but `model` is typed
    // `TTSModels | string` and is passed straight to the API, so Japanese works.
    tts: new deepgram.TTS({
      apiKey: config.DEEPGRAM_API_KEY,
      model: locale === "en" ? config.DEEPGRAM_TTS_MODEL_EN : config.DEEPGRAM_TTS_MODEL_JA,
      // The default splitter only looks at ASCII sentence marks, so Japanese
      // reaches TTS only after generation finishes. English keeps the default
      // English rules; only Japanese sends sentences as soon as they settle.
      ...(locale === "ja" ? { sentenceTokenizer: new JapaneseSentenceTokenizer() } : {}),
    }),
    // LiveKit SDK 1.6.1's `voice/agent_activity.ts` `tee()`s first for both the
    // conversation and `session.say()`, applying this transform inside
    // `performTTSInference` on the TTS branch only; captions get the original
    // string. The defaults must be listed too - passing a custom transform drops
    // Markdown and emoji stripping.
    ttsTextTransforms: ttsTextTransformsForLocale(locale),
    turnHandling: {
      // `turn-detector-v1-mini` is a local EOT model with Japanese (ja) support.
      // The model ships inside `@livekit/local-inference`'s per-OS native
      // dependency; the Worker registers it with the shared inference process and
      // loads it at startup. The SDK auto-creates a detector when unset, but picks
      // `v1` on hosted/dev and `v1-mini` elsewhere, so pin the version to compare
      // #103's `eou_delay_ms` without environment drift. It also avoids a network
      // round trip and Inference billing. The smaller `v1-mini` may be less
      // accurate than `v1` and uses container CPU; if accuracy falls short, check
      // #103's metrics before moving up to `v1`.
      turnDetection: new inference.TurnDetector({ version: "v1-mini" }),
      // `resolveEndpointing` merges partial settings into the defaults, so keep
      // `fixed / minDelay: 300ms` and raise only maxDelay to 4s. On "done" the EOT
      // waits minDelay; on "still talking" it switches to maxDelay (not additive).
      // That leaves over 3s to think during teach-back without slowing down turns
      // that can answer fast.
      endpointing: { maxDelay: 4_000 },
      interruption: {
        // adaptive sends overlapping audio to the cloud, so it is not used here -
        // minors' conversation content stays in. Local VAD-based detection instead.
        // 800ms sits mid-range of the recommended 700-1000ms: coughs and short
        // household noise will not cut the lesson, but a student who really starts
        // talking does.
        minDuration: 800,
        // `minWords` stays at the default 0. The SDK counts words by whitespace,
        // assuming English; a Japanese utterance is always one word, so raising it
        // would hide every student barge-in.
      },
    },
  });
}
