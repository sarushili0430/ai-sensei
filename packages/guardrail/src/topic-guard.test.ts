import { describe, expect, it } from "vitest";
import {
  buildAllowedTopics,
  checkQuestion,
  containsAnswerLeak,
  filterHoleTopicIds,
  filterQuestions,
  isAllowedTopic,
  rejectionGuidance,
} from "./topic-guard.ts";

const allowed = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"]);

describe("buildAllowedTopics", () => {
  it("検出した単元と、その前提を許可する", () => {
    expect(allowed.primary.has("M2-ZUKEI-ENCHOKU")).toBe(true);
    expect(allowed.prerequisite.has("M1-NIJI-HANBETSU")).toBe(true);
    expect(isAllowedTopic(allowed, "M2-ZUKEI-TENTO-KYORI")).toBe(true);
  });

  it("depth=0なら深掘りを許さない", () => {
    const shallow = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"], { prerequisiteDepth: 0 });
    expect(shallow.prerequisite.size).toBe(0);
    expect(isAllowedTopic(shallow, "M1-NIJI-HANBETSU")).toBe(false);
  });

  it("カリキュラムにないIDは黙って捨てる", () => {
    expect(buildAllowedTopics(["M2-SONZAI-SHINAI", "大学数学"]).primary.size).toBe(0);
  });
});

describe("checkQuestion — 通すべきもの", () => {
  it("写真の単元についての素朴な質問", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "なんで中心と直線の距離を出したんですか?" },
      allowed,
    );
    expect(verdict.ok).toBe(true);
  });

  it("前提トピックへの深掘り", () => {
    const verdict = checkQuestion(
      { topic_id: "M1-NIJI-HANBETSU", text: "判別式って、そもそも何がわかるものなんですか?" },
      allowed,
    );
    expect(verdict.ok).toBe(true);
  });
});

// handoff §10-5「意地悪な写真=範囲外・大学数学・数学以外で範囲逸脱しないか」
describe("checkQuestion — 弾くべきもの", () => {
  it("形は正しいがカリキュラムにないtopic_idを弾く(LLMがIDを捏造した場合)", () => {
    const verdict = checkQuestion(
      { topic_id: "M3-SENKEI-DAISU", text: "これはどう求めるんですか?" },
      allowed,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "unknown_topic_id" });
  });

  it("コース接頭辞ごとでたらめなtopic_idを弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "MX-SENKEI-DAISU", text: "これはどう求めるんですか?" },
      allowed,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "malformed_topic_id" });
  });

  it("形の壊れたtopic_idを弾く", () => {
    const verdict = checkQuestion({ topic_id: "線形代数", text: "これは何ですか?" }, allowed);
    expect(verdict).toMatchObject({ ok: false, reason: "malformed_topic_id" });
  });

  it("カリキュラム内でも写真に写っていない単元を弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "MB-SURETSU-SIGMA", text: "Σの計算はどうやるんですか?" },
      allowed,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "topic_not_allowed" });
  });

  it("大学数学の語が混ざった質問を弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "これ、ロピタルの定理を使えばもっと速くないですか?" },
      allowed,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "out_of_scope_wording" });
  });

  it("答えを言ってしまう質問を弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "答えは2点で交わる、ですよね?" },
      allowed,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "answer_leak" });
  });

  it("質問になっていない相づちを弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "なるほど、わかりました。" },
      allowed,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "not_a_question" });
  });
});

describe("containsAnswerLeak", () => {
  it.each([
    "答えは3です",
    "正解は2点で交わるパターンですね",
    "まず平方完成してから代入すれば解けますよ",
  ])("答えを与える文を検出する: %s", (text) => {
    expect(containsAnswerLeak(text)).toBe(true);
  });

  it.each(["なんでそこで判別式を使ったんですか?", "最初の一歩をそれにしたのはどうしてですか?"])(
    "ただの質問は検出しない: %s",
    (text) => {
      expect(containsAnswerLeak(text)).toBe(false);
    },
  );
});

describe("filterQuestions", () => {
  it("通ったものと落ちたものを分け、再生成の指示を引ける", () => {
    const result = filterQuestions(
      [
        { topic_id: "M2-ZUKEI-ENCHOKU", text: "なんでこの方法を選んだんですか?" },
        { topic_id: "MB-SURETSU-SIGMA", text: "数列の和はどう出すんですか?" },
      ],
      allowed,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    const rejected = result.rejected[0];
    expect(rejected?.reason).toBe("topic_not_allowed");
    expect(rejectionGuidance[rejected!.reason]).toContain("写真に写っていない単元");
  });
});

describe("filterHoleTopicIds", () => {
  it("許可範囲外のタグが付いた穴を落とす", () => {
    const result = filterHoleTopicIds(
      [
        { topic_id: "M1-NIJI-HANBETSU", desc: "判別式のなぜで止まった" },
        { topic_id: "M3-SEKIBUN-OYO", desc: "体積の求め方で止まった" },
      ],
      allowed,
    );
    expect(result.accepted.map((hole) => hole.topic_id)).toEqual(["M1-NIJI-HANBETSU"]);
    expect(result.rejected[0]?.reason).toBe("topic_not_allowed");
  });
});
