import { describe, expect, it } from "vitest";
import {
  allowedTopicsLocale,
  buildAllowedTopics,
  checkQuestion,
  containsAnswerLeak,
  containsOutOfScopeTerm,
  filterHoleTopicIds,
  filterQuestions,
  isAllowedTopic,
  rejectionGuidance,
  rejectionGuidanceByLocale,
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

// レビュー指摘: topic_idはLLMの自己申告なので、IDだけを信用すると
// 「許可されたIDを付けたまま別の単元を聞く」が通ってしまう
describe("質問文と単元の突き合わせ", () => {
  it("許可されたIDを付けていても、本文が別単元なら弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "数列の和はどう出すんですか?" },
      allowed,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "text_topic_mismatch" });
  });

  it("単元を推定できない一般的な問いは通す", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "最初の一歩をそれにしたのはどうしてですか?" },
      allowed,
    );
    expect(verdict.ok).toBe(true);
  });

  it("許可単元の語を含む質問は通す", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "中心と直線の距離は何のために出したんですか?" },
      allowed,
    );
    expect(verdict.ok).toBe(true);
  });
});

// レビュー指摘: 疑問符が付いていても中身が答えなら質問ではない
describe("確認の形をした答え", () => {
  it.each([
    "x=2ですよね?",
    "2点で交わるんですよね?",
    "答えは3ですよね?",
    "最大値は5になりますよね?",
  ])("弾く: %s", (text) => {
    expect(containsAnswerLeak(text)).toBe(true);
  });

  it.each([
    "なんでそこで判別式を使ったんですか?",
    "この方法を選んだ理由ってなんですか?",
    "どこから話すか迷ってます?",
  ])("ふつうの質問は通す: %s", (text) => {
    expect(containsAnswerLeak(text)).toBe(false);
  });
});

// 海外向けの課程(Algebra 1 〜 Statistics)。日本語のルールをそのまま
// 当てると、英語のセッションで**答えの漏れが素通しになる**。
describe("英語のセッション", () => {
  const allowedEn = buildAllowedTopics(["A2-COORD-CIRCLE"]);

  it("許可リストからロケールを決める", () => {
    expect(allowedTopicsLocale(allowedEn)).toBe("en");
    expect(allowedTopicsLocale(buildAllowedTopics(["M2-ZUKEI-ENCHOKU"]))).toBe("ja");
    // 空のときは既定(日本の課程)に落とす
    expect(allowedTopicsLocale(buildAllowedTopics([]))).toBe("ja");
  });

  it("英語の質問を通す", () => {
    const verdict = checkQuestion(
      { topic_id: "A2-COORD-CIRCLE", text: "Why did you compare the distance with the radius?" },
      allowedEn,
    );
    expect(verdict.ok).toBe(true);
  });

  it.each([
    "The answer is 2.",
    "Here's how to solve it: substitute and expand.",
    "So x = 2, right?",
    "So the answer is the maximum at the vertex.",
  ])("答えを与える英語の発話を弾く: %s", (text) => {
    expect(containsAnswerLeak(text, "en")).toBe(true);
  });

  it.each([
    "Why did you use the discriminant there?",
    "What made you pick that as the first step?",
    "Could you say a bit more about that part?",
  ])("ふつうの英語の質問は通す: %s", (text) => {
    expect(containsAnswerLeak(text, "en")).toBe(false);
  });

  it("疑問符のない英語の問いかけも質問として通す", () => {
    const verdict = checkQuestion(
      { topic_id: "A2-COORD-CIRCLE", text: "Tell me why the radius matters here" },
      allowedEn,
    );
    expect(verdict.ok).toBe(true);
  });

  it("大学範囲の語を弾く(英語の語彙で)", () => {
    expect(containsOutOfScopeTerm("we need a partial derivative here", "en")).toBe(
      "partial derivative",
    );
    const verdict = checkQuestion(
      { topic_id: "A2-COORD-CIRCLE", text: "Is that an eigenvalue?" },
      allowedEn,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "out_of_scope_wording" });
  });

  // ロピタルの定理は日本の高校では範囲外だが、AP Calculus では扱う。
  // リストを一本にすると、教科書どおりの話題まで弾いてしまう。
  it("範囲外リストは課程ごとに違う", () => {
    expect(containsOutOfScopeTerm("ロピタルの定理を使う", "ja")).toBe("ロピタルの定理");
    expect(containsOutOfScopeTerm("we can use L'Hopital here", "en")).toBeUndefined();
  });

  it("許可外の単元の話をしている英語の質問を弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "A2-COORD-CIRCLE", text: "How do you find the sum of a geometric series?" },
      allowedEn,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "text_topic_mismatch" });
  });

  it("再生成の指示も英語で返す", () => {
    expect(rejectionGuidanceByLocale.en.answer_leak).toMatch(/Do not give the answer/);
    expect(rejectionGuidanceByLocale.ja.answer_leak).toContain("答え");
  });
});
