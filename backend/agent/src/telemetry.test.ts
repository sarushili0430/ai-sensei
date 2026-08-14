import { describe, expect, it, vi } from "vitest";
import { JobLogger, type LogFields, setDegradationReporter } from "./log.ts";
import {
  DegradationThrottle,
  agentDegradations,
  createDegradationReporter,
  degradationKey,
  isDegradation,
  messageMaxLength,
  scrubFields,
  scrubMessage,
} from "./telemetry.ts";

/**
 * Tests for degradation monitoring. Three things:
 *
 *   1. content never leaves (problem text is not even stored in R2)
 *   2. warnings from normal operation cause no alert fatigue (closed set, throttling)
 *   3. with no key, nothing happens (monitoring must not change product behaviour)
 */

describe("isDegradation", () => {
  // Only "something the student should have received did not arrive" belongs here
  it("送信側の縮退を拾う", () => {
    expect(isDegradation("board_append_failed")).toBe(true);
    expect(isDegradation("board_step_rejected")).toBe(true);
    expect(isDegradation("lesson_empty")).toBe(true);
    expect(isDegradation("review_hole_missing")).toBe(true);
    expect(isDegradation("plan_template_fallback")).toBe(true);
  });

  /**
   * Loosen this and nearly every session warns, burying real anomalies.
   * The same failure shape as dropping `containsAnswerLeak` in #12.
   */
  it("正常動作の警告は縮退にしない", () => {
    // Dropping later headings is by design (not dropping them erases the board)
    expect(isDegradation("board_head_ignored")).toBe(false);
    // The delivery layer fixes the LLM's miscounts, so what arrives is correct
    expect(isDegradation("board_step_index_overridden")).toBe(false);
    // Barge-in is the very reason §3-2 chose option A
    expect(isDegradation("lesson_interrupted_by_user")).toBe(false);
  });

  it("見出しは検索とグルーピングのために英語のまま", () => {
    for (const event of agentDegradations) {
      expect(event, event).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    }
  });
});

describe("scrubFields", () => {
  /**
   * `board_opened`'s `title` is a string the LLM wrote from the problem.
   * Problem text is someone else's copyrighted work and is not even stored in R2
   * (plan §4-1).
   */
  it("本文の欄は落とす", () => {
    const scrubbed = scrubFields({
      board_id: "brd_1",
      title: "判別式で解の個数を見る",
      detail: "\\text{よって} が使えません",
      message: "手順のJSONが読めません: ...",
    });

    expect(scrubbed).toEqual({ board_id: "brd_1" });
  });

  // Allow, not deny. When fields are added, default to not sending them
  it("知らない文字列の欄は、既定で落とす", () => {
    expect(scrubFields({ future_field: "何か" })).toEqual({});
  });

  it("数と真偽はそのまま通す(件数・位置・所要時間)", () => {
    expect(scrubFields({ index: 3, step_count: 12, opened: true })).toEqual({
      index: 3,
      step_count: 12,
      opened: true,
    });
  });

  // Arrays and objects are opaque, so drop them whole
  it("入れ子は落とす", () => {
    expect(scrubFields({ utterances: ["答えは2点で交わる"], nested: { tex: "x^2" } })).toEqual({});
  });

  it("種類の判別に要る列挙は通す", () => {
    expect(scrubFields({ reason: "text_in_math", session_id: "ses_1" })).toEqual({
      reason: "text_in_math",
      session_id: "ses_1",
    });
  });
});

describe("DegradationThrottle", () => {
  it("同じ鍵は1回だけ通す", () => {
    const throttle = new DegradationThrottle();
    expect(throttle.allow("a")).toBe(true);
    expect(throttle.allow("a")).toBe(false);
    expect(throttle.allow("b")).toBe(true);
  });

  // Remembering without bound makes only this grow in a long-running worker
  it("上限に達したら全部忘れる(送りすぎより黙るほうが困る)", () => {
    const throttle = new DegradationThrottle(2);
    throttle.allow("a");
    throttle.allow("b");
    // It forgets here, so `a` passes exactly once more
    expect(throttle.allow("c")).toBe(true);
    expect(throttle.allow("a")).toBe(true);
  });
});

describe("degradationKey", () => {
  // One lesson streams dozens of steps. One per board is enough to locate it
  it("板書がらみは board_id 単位", () => {
    expect(degradationKey("board_step_rejected", { board_id: "brd_1", session_id: "ses_1" })).toBe(
      "board_step_rejected/brd_1",
    );
  });

  it("board_id を持たない縮退はセッション単位", () => {
    expect(degradationKey("board_publisher_missing", { session_id: "ses_1" })).toBe(
      "board_publisher_missing/ses_1",
    );
  });

  it("計画の縮退は計画セッション単位", () => {
    expect(
      degradationKey("plan_template_fallback", { plan_session_id: "pls_1", reason: "shape" }),
    ).toBe("plan_template_fallback/pls_1");
  });
});

describe("createDegradationReporter", () => {
  it("縮退だけを、伏せ字にして1回だけ送る", () => {
    const capture = vi.fn();
    const report = createDegradationReporter(capture);

    report("board_step_rejected", { board_id: "brd_1", index: 2, detail: "描けない式" });
    report("board_step_rejected", { board_id: "brd_1", index: 5, detail: "また描けない式" });
    report("board_head_ignored", { board_id: "brd_1", title: "判別式" });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("board_step_rejected", { board_id: "brd_1", index: 2 });
  });

  it("板書が違えば別の出来事として送る", () => {
    const capture = vi.fn();
    const report = createDegradationReporter(capture);

    report("board_append_failed", { board_id: "brd_1" });
    report("board_append_failed", { board_id: "brd_2" });

    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe("JobLogger と縮退の配線", () => {
  function sink() {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line) };
  }

  /**
   * With no key, do nothing. Monitoring must never change product behaviour
   * (the same promise as mobile's `SentryConfig.isConfigured`).
   */
  it("受け皿が無ければ何も起きない", () => {
    setDegradationReporter(null);
    const out = sink();
    const log = new JobLogger({ session_id: "ses_1" }, out.write, out.write);

    expect(() => log.warn("board_append_failed", { board_id: "brd_1" })).not.toThrow();
    expect(out.lines).toHaveLength(1);
  });

  it("warn は標準出力と受け皿の両方に出る", () => {
    const captured: { event: string; fields: LogFields }[] = [];
    setDegradationReporter((event, fields) => captured.push({ event, fields }));

    const out = sink();
    const log = new JobLogger({ session_id: "ses_1" }, out.write, out.write);
    log.warn("board_append_failed", { board_id: "brd_1" });

    // stdout still gets everything, as before (separate from what monitoring sees)
    expect(JSON.parse(out.lines[0] as string)).toMatchObject({
      level: "warn",
      event: "board_append_failed",
      session_id: "ses_1",
      board_id: "brd_1",
    });
    // The sink also receives `session_id` (from base)
    expect(captured[0]).toEqual({
      event: "board_append_failed",
      fields: { session_id: "ses_1", board_id: "brd_1" },
    });

    setDegradationReporter(null);
  });

  // Crashes and degradations do not share a shelf. error still goes to ErrorReporter
  it("error は縮退の口には流れない", () => {
    const captured: string[] = [];
    setDegradationReporter((event) => captured.push(event));

    const out = sink();
    new JobLogger({}, out.write, out.write).error("karte_failed", new Error("boom"));

    expect(captured).toEqual([]);
    setDegradationReporter(null);
  });
});

describe("scrubMessage", () => {
  /**
   * The server version of the trap mobile hit. Exceptions from external SDKs
   * (LiveKit / Deepgram / Anthropic) reach `captureException` verbatim, so URLs
   * and tokens can fly out the same way.
   */
  it("URLはスキームとホストまでにする(秘密はパスとクエリに乗る)", () => {
    expect(
      scrubMessage("connect failed: wss://example.livekit.cloud/rtc?access_token=abc.def"),
    ).toBe("connect failed: wss://example.livekit.cloud/…");
  });

  // Which service failed matters, so keep the host
  it("ホストは残す", () => {
    expect(scrubMessage("https://api.anthropic.com/v1/messages で失敗")).toContain(
      "https://api.anthropic.com",
    );
  });

  it("トークンらしい長い塊は潰す", () => {
    // Not real - an input for testing redaction. Secret scanners flagging this is
    // correct behaviour, so allow just this line.
    const fakeKey = "sk-ant-api03-AAAABBBBCCCCDDDD"; // pragma: allowlist secret
    expect(scrubMessage(`x-api-key ${fakeKey} が拒否されました`)).not.toContain("AAAABBBBCCCCDDDD");
  });

  // Ordinary sentences and short formulas are not collateral (unreadable is useless)
  it("ふつうの文はそのまま残る", () => {
    expect(scrubMessage("板書のJSONが長すぎます(64001 > 64000)")).toBe(
      "板書のJSONが長すぎます(64001 > 64000)",
    );
  });

  /**
   * Our own messages embed API response bodies (`lesson.ts`'s
   * "板書の生成に失敗しました: <status> <body>"), which can contain LLM output.
   */
  it("長すぎるメッセージは切る", () => {
    const long = `板書の生成に失敗しました: 400 ${"あ".repeat(500)}`;
    const scrubbed = scrubMessage(long);
    expect(scrubbed.length).toBeLessThanOrEqual(messageMaxLength + 1);
    expect(scrubbed.endsWith("…")).toBe(true);
  });
});

describe("scrubFields(エラーの文脈)", () => {
  // `log.error` fields are allow-listed too; passing through would ship new fields by default
  it("ログの見出しは通し、本文は落とす", () => {
    expect(scrubFields({ event: "karte_failed", session_id: "ses_1", title: "判別式" })).toEqual({
      event: "karte_failed",
      session_id: "ses_1",
    });
  });
});
