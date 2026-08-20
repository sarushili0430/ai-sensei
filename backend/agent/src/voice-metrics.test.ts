import { voice } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { JobLogger } from "./log.ts";
import { observeVoiceMetrics } from "./voice-metrics.ts";

type Listener = (event: unknown) => void;

class SessionEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function setup() {
  const lines: string[] = [];
  const emitter = new SessionEmitter();
  const log = new JobLogger(
    {},
    (line) => lines.push(line),
    (line) => lines.push(line),
  );
  const observed = observeVoiceMetrics(emitter as unknown as voice.AgentSession, log);
  return { emitter, lines, observed };
}

describe("observeVoiceMetrics", () => {
  it("先輩3秒・生徒9秒の発話時間比を生徒 ÷ 先輩で返す", () => {
    const { emitter, observed } = setup();

    emitter.emit(voice.AgentSessionEventTypes.AgentStateChanged, {
      type: "agent_state_changed",
      oldState: "idle",
      newState: "speaking",
      createdAt: 1_000,
    });
    emitter.emit(voice.AgentSessionEventTypes.AgentStateChanged, {
      type: "agent_state_changed",
      oldState: "speaking",
      newState: "listening",
      createdAt: 4_000,
    });
    emitter.emit(voice.AgentSessionEventTypes.UserStateChanged, {
      type: "user_state_changed",
      oldState: "listening",
      newState: "speaking",
      createdAt: 5_000,
    });
    emitter.emit(voice.AgentSessionEventTypes.UserStateChanged, {
      type: "user_state_changed",
      oldState: "speaking",
      newState: "listening",
      createdAt: 14_000,
    });

    expect(observed.summary(new Date(20_000))).toMatchObject({
      agent_speech_seconds: 3,
      user_speech_seconds: 9,
      speech_ratio: 3,
    });
  });

  it("終了時まで speaking の区間も summary に含める", () => {
    const { emitter, observed } = setup();

    emitter.emit(voice.AgentSessionEventTypes.AgentStateChanged, {
      type: "agent_state_changed",
      oldState: "idle",
      newState: "speaking",
      createdAt: 2_000,
    });

    expect(observed.summary(new Date(7_000))).toMatchObject({ agent_speech_seconds: 5 });

    // `close()` が後から speaking を抜けさせても、会話終了時刻を越えた分は混ぜない。
    emitter.emit(voice.AgentSessionEventTypes.AgentStateChanged, {
      type: "agent_state_changed",
      oldState: "speaking",
      newState: "listening",
      createdAt: 8_000,
    });
    expect(observed.summary(new Date(7_000))).toMatchObject({ agent_speech_seconds: 5 });
  });

  it("interimを畳み、本文を含めず final でだけ生徒ターンを記録する", () => {
    const { emitter, lines } = setup();
    const transcript = "三平方の定理がわかりません";

    emitter.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
      type: "user_input_transcribed",
      transcript: "三平方の",
      isFinal: false,
      itemId: null,
      speakerId: null,
      language: "ja",
      createdAt: 1_000,
    });
    emitter.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
      type: "user_input_transcribed",
      transcript: "三平方の定理が",
      isFinal: false,
      itemId: null,
      speakerId: null,
      language: "ja",
      createdAt: 1_500,
    });
    emitter.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
      type: "user_input_transcribed",
      transcript,
      isFinal: true,
      itemId: null,
      speakerId: null,
      language: "ja",
      createdAt: 2_000,
    });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toEqual([
      expect.objectContaining({
        event: "user_turn_transcribed",
        interim_count: 2,
        final_chars: transcript.length,
        first_interim_to_final_ms: 1_000,
      }),
    ]);
    expect(lines.join("\n")).not.toContain(transcript);
  });

  it("EOU遅延とTTFBを平均・最大で返す", () => {
    const { emitter, observed } = setup();

    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 1_000,
      metrics: {
        type: "eou_metrics",
        timestamp: 1_000,
        endOfUtteranceDelayMs: 100,
        transcriptionDelayMs: 20,
        onUserTurnCompletedDelayMs: 10,
        lastSpeakingTimeMs: 900,
      },
    });
    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 2_000,
      metrics: {
        type: "eou_metrics",
        timestamp: 2_000,
        endOfUtteranceDelayMs: 300,
        transcriptionDelayMs: 30,
        onUserTurnCompletedDelayMs: 20,
        lastSpeakingTimeMs: 1_900,
      },
    });
    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 3_000,
      metrics: {
        type: "llm_metrics",
        label: "anthropic",
        requestId: "req_1",
        timestamp: 3_000,
        durationMs: 500,
        ttftMs: 200,
        cancelled: false,
        completionTokens: 1,
        promptTokens: 1,
        promptCachedTokens: 0,
        totalTokens: 2,
        tokensPerSecond: 2,
      },
    });
    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 4_000,
      metrics: {
        type: "llm_metrics",
        label: "anthropic",
        requestId: "req_2",
        timestamp: 4_000,
        durationMs: 500,
        ttftMs: 400,
        cancelled: false,
        completionTokens: 1,
        promptTokens: 1,
        promptCachedTokens: 0,
        totalTokens: 2,
        tokensPerSecond: 2,
      },
    });
    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 5_000,
      metrics: {
        type: "tts_metrics",
        label: "deepgram",
        requestId: "req_3",
        timestamp: 5_000,
        ttfbMs: 150,
        durationMs: 500,
        audioDurationMs: 400,
        cancelled: false,
        charactersCount: 10,
        streamed: true,
      },
    });
    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 6_000,
      metrics: {
        type: "tts_metrics",
        label: "deepgram",
        requestId: "req_4",
        timestamp: 6_000,
        ttfbMs: 250,
        durationMs: 500,
        audioDurationMs: 400,
        cancelled: false,
        charactersCount: 10,
        streamed: true,
      },
    });

    expect(observed.summary()).toMatchObject({
      eou_delay_ms_avg: 200,
      eou_delay_ms_max: 300,
      llm_ttft_ms_avg: 300,
      tts_ttfb_ms_avg: 200,
    });
  });

  // 指示文は1万トークン級で毎ターン再送される(`conversation-llm.ts`)。効いているかは
  // 「キャッシュから読めた割合」でしか分からないので、比まで出す。
  it("会話LLMの入力トークンとキャッシュ読みを積み上げ、比を出す", () => {
    const { emitter, observed } = setup();

    function llmTurn(promptTokens: number, promptCachedTokens: number, at: number) {
      emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
        type: "metrics_collected",
        createdAt: at,
        metrics: {
          type: "llm_metrics",
          label: "anthropic",
          requestId: `req_${at}`,
          timestamp: at,
          durationMs: 500,
          ttftMs: 200,
          cancelled: false,
          completionTokens: 40,
          promptTokens,
          promptCachedTokens,
          totalTokens: promptTokens + 40,
          tokensPerSecond: 80,
        },
      });
    }

    // 1ターン目は書き込みなのでヒット0。2・3ターン目で指示文ぶんが読めている。
    llmTurn(10_000, 0, 1_000);
    llmTurn(10_200, 9_800, 2_000);
    llmTurn(10_400, 9_800, 3_000);

    expect(observed.summary()).toMatchObject({
      llm_prompt_tokens: 30_600,
      llm_cached_tokens: 19_600,
      llm_cache_hit_ratio: 0.64,
    });
  });

  it("会話LLMが一度も動かなければキャッシュの比は null", () => {
    expect(setup().observed.summary()).toMatchObject({
      llm_prompt_tokens: 0,
      llm_cached_tokens: 0,
      llm_cache_hit_ratio: null,
    });
  });

  it("割り込みと相槌をイベントごとの増分から累積する", () => {
    const { emitter, observed } = setup();

    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 1_000,
      metrics: {
        type: "interruption_metrics",
        timestamp: 1_000,
        numInterruptions: 1,
        numBackchannels: 0,
      },
    });
    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 2_000,
      metrics: {
        type: "interruption_metrics",
        timestamp: 2_000,
        numInterruptions: 0,
        numBackchannels: 1,
      },
    });
    emitter.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: 3_000,
      metrics: {
        type: "interruption_metrics",
        timestamp: 3_000,
        numInterruptions: 0,
        numBackchannels: 1,
      },
    });

    expect(observed.summary()).toMatchObject({ interruptions: 1, backchannels: 2 });
  });

  it("誤割り込みと発話の重なりを数え、生音声と確率列はログに出さない", () => {
    const { emitter, lines, observed } = setup();
    const speechInput = new Int16Array([12_345, -23_456]);
    const probabilities = [0.123456789, 0.987654321];

    emitter.emit(voice.AgentSessionEventTypes.AgentFalseInterruption, {
      type: "agent_false_interruption",
      resumed: true,
    });
    emitter.emit(voice.AgentSessionEventTypes.OverlappingSpeech, {
      type: "overlapping_speech",
      speechInput,
      probabilities,
      isInterruption: true,
      probability: 0.8,
      detectionDelayInS: 0.2,
      agentEnded: false,
    });

    expect(observed.summary()).toMatchObject({
      false_interruptions: 1,
      overlapping_speeches: 1,
    });
    const logged = lines.join("\n");
    expect(logged).not.toContain("12345");
    expect(logged).not.toContain("23456");
    expect(logged).not.toContain("0.123456789");
    expect(logged).not.toContain("0.987654321");
  });
});
