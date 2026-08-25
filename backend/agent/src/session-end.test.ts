import { voice } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { JobLogger } from "./log.ts";
import { endedReasonOfClose, watchSessionEnd } from "./session-end.ts";

/**
 * **授業が途中でブチッと切れる**の再発を止めるためのテスト。
 *
 * 症状はアプリ側(締めの言葉もなく祝福画面へ飛ぶ)に出るが、原因はここ —
 * SDKが「再試行しています」と言っているだけの `error` を、こちらが
 * 「終わりました」と読んでいた。会話LLMは**再試行のたびに1件出す**ので、
 * Anthropic の 429 が1回混ざるだけで、残り10分あっても授業が終わっていた。
 */

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
    { session_id: "s_1" },
    (line) => lines.push(line),
    (line) => lines.push(line),
  );
  const finish = vi.fn();
  watchSessionEnd({ session: emitter as unknown as voice.AgentSession, finish, log });
  return { emitter, lines, finish };
}

function pipelineError(recoverable: boolean) {
  return {
    type: "error",
    error: {
      type: "llm_error",
      timestamp: 0,
      label: "anthropic.LLM",
      error: new Error("429 rate_limit_error"),
      recoverable,
    },
    createdAt: 0,
  };
}

function closed(reason: voice.ShutdownReason) {
  return { type: "close", error: null, reason, createdAt: 0 };
}

describe("watchSessionEnd", () => {
  it("再試行中のエラーでは降りない(SDKが立て直している最中)", () => {
    const { emitter, lines, finish } = setup();

    emitter.emit(voice.AgentSessionEventTypes.Error, pipelineError(true));

    expect(finish).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      event: "voice_pipeline_error",
      session_id: "s_1",
      reason: "llm_error",
      label: "anthropic.LLM",
      recoverable: true,
      error_name: "Error",
    });
  });

  /**
   * 立て直せなかった1件も、**それ自体では降ろさない**。
   * LLM / TTS は3件まで、STT は1件で、`AgentSession` 側が閉じると決める
   * (`_onError`)。こちらで先に降りると、その方針を上書きしてしまう。
   */
  it("立て直せなかったエラーは縮退として記録するが、まだ降りない", () => {
    const { emitter, lines, finish } = setup();

    emitter.emit(voice.AgentSessionEventTypes.Error, pipelineError(false));

    expect(finish).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "warn",
      event: "voice_pipeline_error",
      recoverable: false,
    });
  });

  it("内側の例外を持たないエラー(割り込み検出)でも落ちない", () => {
    const { emitter, lines, finish } = setup();
    const failure = new Error("interruption detection unavailable");

    emitter.emit(voice.AgentSessionEventTypes.Error, {
      type: "error",
      error: Object.assign(failure, {
        type: "interruption_detection_error",
        timestamp: 0,
        label: "inference.InterruptionDetector",
        recoverable: false,
      }),
      createdAt: 0,
    });

    expect(finish).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "voice_pipeline_error",
      reason: "interruption_detection_error",
      error_name: "Error",
    });
  });

  it("SDKが見限って閉じたら error として降りる", () => {
    const { emitter, finish } = setup();

    emitter.emit(voice.AgentSessionEventTypes.Close, closed(voice.CloseReason.ERROR));

    expect(finish).toHaveBeenCalledWith("error");
  });

  it("生徒が部屋を出たら user_left として降りる", () => {
    const { emitter, finish } = setup();

    emitter.emit(
      voice.AgentSessionEventTypes.Close,
      closed(voice.CloseReason.PARTICIPANT_DISCONNECTED),
    );

    expect(finish).toHaveBeenCalledWith("user_left");
  });
});

describe("endedReasonOfClose", () => {
  /**
   * ワーカーの入れ替えで切れた回を `user_left` に混ぜない。混ぜると記録の上では
   * 「みんな自分から降りている」ことになり、途中で切れた回を数える手段が消える。
   */
  it("ワーカーの畳み込みは生徒の離脱ではない", () => {
    expect(endedReasonOfClose(voice.CloseReason.JOB_SHUTDOWN)).toBe("error");
  });

  it("自分で閉じた後片付けは user_left のまま(実際には記録に出ない)", () => {
    expect(endedReasonOfClose(voice.CloseReason.USER_INITIATED)).toBe("user_left");
  });
});
