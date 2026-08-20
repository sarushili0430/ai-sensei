import { voice } from "@livekit/agents";
import type { JobLogger } from "./log.ts";

/**
 * 音声パイプラインを変える #99 (TTS変換) / #101 (文分割器) / #102 (ターンテイキング) の
 * 効果を、体感ではなくセッションごとの数字で比較するための観測点。
 *
 * TTS の TTFB は #101、EOU 遅延は #102 の効き先として見る。変更ごとに「速くなった
 * 気がする」で終わらせず、発話時間比・遅延・割り込みの内訳を並べて、教え返しが
 * 実際に成立しているかを確かめる。
 *
 * 生徒は未成年で、問題文は他者の著作物なので、既存の `telemetry.ts` と同じ方針で
 * 本文・生音声・確率列をログに載せない。ここは `log.info` のため現状は Sentry へ
 * 流れないが、将来 `warn` に変える人にも理由が残るようにしている。
 */
export type VoiceMetricsSummary = {
  agent_speech_seconds: number;
  user_speech_seconds: number;
  speech_ratio: number | null;
  eou_delay_ms_avg: number | null;
  eou_delay_ms_max: number | null;
  llm_ttft_ms_avg: number | null;
  /** 会話LLMへ送った入力トークン(キャッシュ読みを含む合計)。原価の主役はここ。 */
  llm_prompt_tokens: number;
  /** そのうちキャッシュから読めたぶん。単価は通常入力の 0.1 倍。 */
  llm_cached_tokens: number;
  /**
   * `llm_cached_tokens / llm_prompt_tokens`。**プロンプトキャッシュが効いているかの一次指標。**
   *
   * 指示文は1万トークン級で毎ターン再送されるので、効いていれば 0.8 前後に張り付く。
   * 0 のまま動かないときは、指示文が毎ターン変わっているか、
   * Haiku 4.5 の最小長(4,096トークン)を割って黙って無視されているかのどちらか
   * (`conversation-llm.ts`)。
   */
  llm_cache_hit_ratio: number | null;
  tts_ttfb_ms_avg: number | null;
  user_turns: number;
  false_interruptions: number;
  overlapping_speeches: number;
  interruptions: number;
  backchannels: number;
};

export function observeVoiceMetrics(
  session: voice.AgentSession,
  log: JobLogger,
): { summary: (at?: Date) => VoiceMetricsSummary } {
  const eouDelays: number[] = [];
  const llmTtfts: number[] = [];
  let llmPromptTokens = 0;
  let llmCachedTokens = 0;
  const ttsTtfbs: number[] = [];
  const agentSpeechRanges: SpeakingRange[] = [];
  const userSpeechRanges: SpeakingRange[] = [];
  let agentSpeakingStartedAt: number | null = null;
  let userSpeakingStartedAt: number | null = null;
  let interimCount = 0;
  let firstInterimAt: number | null = null;
  let userTurns = 0;
  let falseInterruptions = 0;
  let overlappingSpeeches = 0;
  let interruptions = 0;
  let backchannels = 0;

  session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => {
    const metrics = event.metrics;
    switch (metrics.type) {
      case "eou_metrics":
        eouDelays.push(metrics.endOfUtteranceDelayMs);
        log.info("voice_metrics", {
          kind: metrics.type,
          end_of_utterance_delay_ms: metrics.endOfUtteranceDelayMs,
          transcription_delay_ms: metrics.transcriptionDelayMs,
          speech_id: metrics.speechId,
        });
        break;
      case "llm_metrics":
        llmTtfts.push(metrics.ttftMs);
        llmPromptTokens += metrics.promptTokens;
        llmCachedTokens += metrics.promptCachedTokens;
        log.info("voice_metrics", {
          kind: metrics.type,
          label: metrics.label,
          request_id: metrics.requestId,
          speech_id: metrics.speechId,
          ttft_ms: metrics.ttftMs,
          // レイテンシだけ見ていると原価が見えない。指示文の再送が会話の中身より
          // 高くつく構造(`conversation-llm.ts`)なので、トークン数も1行に載せる。
          prompt_tokens: metrics.promptTokens,
          cached_tokens: metrics.promptCachedTokens,
          completion_tokens: metrics.completionTokens,
        });
        break;
      case "tts_metrics":
        ttsTtfbs.push(metrics.ttfbMs);
        log.info("voice_metrics", {
          kind: metrics.type,
          label: metrics.label,
          request_id: metrics.requestId,
          speech_id: metrics.speechId,
          ttfb_ms: metrics.ttfbMs,
          audio_duration_ms: metrics.audioDurationMs,
        });
        break;
      case "stt_metrics":
        log.info("voice_metrics", {
          kind: metrics.type,
          label: metrics.label,
          request_id: metrics.requestId,
          audio_duration_ms: metrics.audioDurationMs,
        });
        break;
      case "interruption_metrics":
        // SDK は累積値ではなく、このイベントで増えた 0 / 1 を送る。
        interruptions += metrics.numInterruptions;
        backchannels += metrics.numBackchannels;
        log.info("voice_metrics", {
          kind: metrics.type,
          num_interruptions: metrics.numInterruptions,
          num_backchannels: metrics.numBackchannels,
        });
        break;
      default:
        break;
    }
  });

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    if (!event.isFinal) {
      interimCount += 1;
      firstInterimAt ??= event.createdAt;
      return;
    }
    userTurns += 1;
    log.info("user_turn_transcribed", {
      interim_count: interimCount,
      final_chars: event.transcript.length,
      first_interim_to_final_ms:
        firstInterimAt === null ? null : Math.max(0, event.createdAt - firstInterimAt),
    });
    interimCount = 0;
    firstInterimAt = null;
  });

  session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, (event) => {
    falseInterruptions += 1;
    log.info("agent_false_interruption", { resumed: event.resumed });
  });

  session.on(voice.AgentSessionEventTypes.OverlappingSpeech, (event) => {
    overlappingSpeeches += 1;
    log.info("overlapping_speech", {
      is_interruption: event.isInterruption,
      probability: event.probability,
      detection_delay_in_s: event.detectionDelayInS,
      agent_ended: event.agentEnded,
    });
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
    if (event.newState === "speaking") {
      agentSpeakingStartedAt ??= event.createdAt;
      return;
    }
    if (agentSpeakingStartedAt !== null) {
      agentSpeechRanges.push({ startedAt: agentSpeakingStartedAt, endedAt: event.createdAt });
      agentSpeakingStartedAt = null;
    }
  });

  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    // VAD の発話区間なので、咳や生活音も user_speech_seconds に混じりうる。
    // user_turns は STT の final 回数で別の出所のため、両者がずれても異常とは限らない。
    if (event.newState === "speaking") {
      userSpeakingStartedAt ??= event.createdAt;
      return;
    }
    if (userSpeakingStartedAt !== null) {
      userSpeechRanges.push({ startedAt: userSpeakingStartedAt, endedAt: event.createdAt });
      userSpeakingStartedAt = null;
    }
  });

  return {
    summary: (at = new Date()) => {
      const endMs = at.getTime();
      const totalAgentSpeechMs =
        speakingDurationUntil(agentSpeechRanges, endMs) +
        (agentSpeakingStartedAt === null ? 0 : durationUntil(agentSpeakingStartedAt, endMs));
      const totalUserSpeechMs =
        speakingDurationUntil(userSpeechRanges, endMs) +
        (userSpeakingStartedAt === null ? 0 : durationUntil(userSpeakingStartedAt, endMs));
      const agentSpeechSeconds = totalAgentSpeechMs / 1000;
      const userSpeechSeconds = totalUserSpeechMs / 1000;

      return {
        agent_speech_seconds: roundToTwo(agentSpeechSeconds),
        user_speech_seconds: roundToTwo(userSpeechSeconds),
        // 教え返しでは生徒が長く話せることが成功なので、生徒 ÷ 先輩にする。
        // 分子を逆にすると、値を見るたびにどちらが話した比率かを読み直す必要がある。
        // 1 未満なら、生徒が説明する教え返しが成立していないと一発で判定できる。
        speech_ratio:
          agentSpeechSeconds === 0 ? null : roundToTwo(userSpeechSeconds / agentSpeechSeconds),
        eou_delay_ms_avg: average(eouDelays),
        eou_delay_ms_max: maximum(eouDelays),
        llm_ttft_ms_avg: average(llmTtfts),
        llm_prompt_tokens: llmPromptTokens,
        llm_cached_tokens: llmCachedTokens,
        llm_cache_hit_ratio:
          llmPromptTokens === 0 ? null : roundToTwo(llmCachedTokens / llmPromptTokens),
        tts_ttfb_ms_avg: average(ttsTtfbs),
        user_turns: userTurns,
        false_interruptions: falseInterruptions,
        overlapping_speeches: overlappingSpeeches,
        interruptions,
        backchannels,
      };
    },
  };
}

type SpeakingRange = {
  startedAt: number;
  endedAt: number;
};

function speakingDurationUntil(ranges: SpeakingRange[], endMs: number): number {
  return ranges.reduce(
    (total, range) => total + durationUntil(range.startedAt, Math.min(range.endedAt, endMs)),
    0,
  );
}

function durationUntil(startedAt: number, endMs: number): number {
  return Math.max(0, endMs - startedAt);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return roundToTwo(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function maximum(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}
