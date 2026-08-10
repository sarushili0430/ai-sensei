import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import { TranscriptCollector, renderTranscript } from "./transcript.ts";

const context = readSessionContext(
  JSON.stringify({
    session_id: "ses_1",
    problem_text: "x^2 - 3x + 2 = 0 を解け",
    visible_work: "- 因数分解しかけて止まっている",
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

  it("先輩の発話は正規化しない(TTS向けの整形済みテキスト)", () => {
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

  /**
   * 答えの漏れは**もう見ていない**(ピボット計画 v1 §0 の改正・§8 の「捨てる」列)。
   * 先輩は詰まった箇所を教えるのが仕事なので、当てたままだと
   * **ほぼ全セッションが漏れとして記録され、警告が鳴りっぱなしになる**。
   *
   * 教えた発話も、そのまま transcript に載る(カルテ生成の文脈として要る)。
   * 授業フェーズの発話が載らないのは `addToChatCtx: false` のほうの手当てで、
   * ここではない。
   */
  it("先輩が答えを教えた発話も、そのまま積む", () => {
    const collector = new TranscriptCollector(startedAt, context);
    collector.add({ role: "assistant", text: "答えは2点で交わる、だね。", at: at(4) });

    expect(collector.all.map((message) => message.text)).toEqual(["答えは2点で交わる、だね。"]);
  });
});

describe("renderTranscript", () => {
  it("役割つきで並べる", () => {
    expect(
      renderTranscript([
        { role: "assistant", text: "なんでですか?", at_ms: 0 },
        { role: "user", text: "距離で比べました", at_ms: 1000 },
      ]),
    ).toBe("先輩: なんでですか?\nユーザー: 距離で比べました");
  });

  it("発話がなければプレースホルダ", () => {
    expect(renderTranscript([])).toBe("(発話なし)");
  });
});

describe("英語のセッション", () => {
  const englishContext = readSessionContext(
    JSON.stringify({
      session_id: "ses_en",
      problem_text: "x^2 - 3x + 2 = 0 を解け",
      visible_work: "- 因数分解しかけて止まっている",
      locale: "en",
      max_seconds: 300,
      allowed_topic_ids: ["A2-COORD-CIRCLE"],
    }),
  );

  it("ユーザーの発話には英語の正規化をかける", () => {
    const collector = new TranscriptCollector(startedAt, englishContext);
    collector.add({ role: "user", text: "I substituted x squared", at: at(1) });
    expect(collector.all[0]?.text).toBe("I substituted x^2");
  });

  it("transcriptは英語のロール名で書き出す(プロンプト側と揃える)", () => {
    expect(
      renderTranscript(
        [
          { role: "assistant", text: "Why is that?", at_ms: 1000 },
          { role: "user", text: "Because of the radius", at_ms: 4000 },
        ],
        "en",
      ),
    ).toBe("Senpai: Why is that?\nStudent: Because of the radius");
  });
});
