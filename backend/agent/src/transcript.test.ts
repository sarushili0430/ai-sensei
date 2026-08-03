import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import { TranscriptCollector, renderTranscript } from "./transcript.ts";

const context = readSessionContext(
  JSON.stringify({
    session_id: "ses_1",
    max_seconds: 300,
    allowed_topic_ids: ["M2-ZUKEI-ENCHOKU"],
  }),
);

const startedAt = new Date("2026-08-03T13:00:00.000Z");
const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000);

describe("TranscriptCollector", () => {
  it("経過ミリ秒つきで積む", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "assistant", text: "なんで距離で比べたんですか?", at: at(2) });
    collector.add({ role: "user", text: "半径と比べたかったからです", at: at(9) });

    expect(collector.all).toEqual([
      { role: "assistant", text: "なんで距離で比べたんですか?", at_ms: 2000 },
      { role: "user", text: "半径と比べたかったからです", at_ms: 9000 },
    ]);
  });

  it("ユーザーの発話には数式音声の正規化をかける", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "user", text: "エックスの2乗を代入しました", at: at(1) });
    expect(collector.all[0]?.text).toBe("x^2を代入しました");
  });

  it("後輩の発話は正規化しない(TTS向けの整形済みテキスト)", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "assistant", text: "エックスの2乗の話ですよね?", at: at(1) });
    expect(collector.all[0]?.text).toBe("エックスの2乗の話ですよね?");
  });

  it("空の発話は捨てる", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "user", text: "   ", at: at(1) });
    expect(collector.all).toEqual([]);
  });

  it("開始前の時刻でも負にならない", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "user", text: "はい", at: new Date(startedAt.getTime() - 5000) });
    expect(collector.all[0]?.at_ms).toBe(0);
  });

  it("ユーザーが一度も喋っていない会話を見分ける", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "assistant", text: "聞いてもいいですか?", at: at(1) });
    expect(collector.hasUserSpeech).toBe(false);

    collector.add({ role: "user", text: "はい", at: at(3) });
    expect(collector.hasUserSpeech).toBe(true);
  });

  // 会話中に差し止めることはできないので、記録してプロンプト調整の材料にする
  it("後輩が答えを漏らした発話を記録する", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "assistant", text: "答えは2点で交わる、ですよね?", at: at(4) });
    collector.add({ role: "assistant", text: "なんでそうしたんですか?", at: at(8) });

    expect(collector.answerLeaks).toEqual(["答えは2点で交わる、ですよね?"]);
  });

  it("ユーザーの発話は答え漏れとして数えない", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "user", text: "答えは2点で交わるです", at: at(4) });
    expect(collector.answerLeaks).toEqual([]);
  });
});

describe("renderTranscript", () => {
  it("役割つきで並べる", () => {
    expect(
      renderTranscript([
        { role: "assistant", text: "なんでですか?", at_ms: 0 },
        { role: "user", text: "距離で比べました", at_ms: 1000 },
      ]),
    ).toBe("後輩: なんでですか?\nユーザー: 距離で比べました");
  });

  it("発話がなければプレースホルダ", () => {
    expect(renderTranscript([])).toBe("(発話なし)");
  });
});
