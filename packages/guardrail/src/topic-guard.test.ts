import { describe, expect, it } from "vitest";
import {
  allowedSubjects,
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

// 英文法のセッションでも、二重ガードは同じ形で効かないといけない。
describe("英文法のセッション", () => {
  const grammar = buildAllowedTopics(["EG-JISEI-GENZAI-KANRYO"]);

  it("許可リストの科目を引ける", () => {
    expect(allowedSubjects(grammar)).toEqual(["英文法"]);
    expect(allowedSubjects(allowed)).toEqual(["数学"]);
  });

  it("前提は同じ科目の中だけをたどる", () => {
    expect(grammar.prerequisite.has("EG-JISEI-GENZAI-KAKO")).toBe(true);
    for (const id of [...grammar.primary, ...grammar.prerequisite]) {
      expect(id.startsWith("EG-"), id).toBe(true);
    }
  });

  it("数学のtopic_idは許可リストに入っていないので弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "なんで判別式を使ったんですか?" },
      grammar,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "topic_not_allowed" });
  });

  it("言語学の用語は範囲外として弾く", () => {
    const verdict = checkQuestion(
      { topic_id: "EG-JISEI-GENZAI-KANRYO", text: "これって統語論ではどう説明するんですか?" },
      grammar,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "out_of_scope_wording" });
  });

  it("素朴な「なぜ」は通す", () => {
    const verdict = checkQuestion(
      {
        topic_id: "EG-JISEI-GENZAI-KANRYO",
        text: "なんでここは過去形じゃなくて現在完了なんですか?",
      },
      grammar,
    );
    expect(verdict.ok).toBe(true);
  });

  // 文法用語を言い当ててしまうと、ユーザーが自分で気づく余地がなくなる
  it.each(["ここ、現在完了ですよね?", "これは分詞構文ですよね?", "関係代名詞の主格ですよね?"])(
    "確認の形をした答えを弾く: %s",
    (text) => {
      expect(containsAnswerLeak(text)).toBe(true);
    },
  );

  // 「比較」「否定」「省略」はどちらの科目にもある日本語。科目を絞らずに
  // 本文から単元を推定すると、まっとうな数学の質問が英文法と見なされて落ちる。
  it("数学のセッションで「比較」を含む質問を、英文法と取り違えない", () => {
    const verdict = checkQuestion(
      { topic_id: "M2-ZUKEI-ENCHOKU", text: "なんで距離と半径を比較して判定したんですか?" },
      allowed,
    );
    expect(verdict.ok).toBe(true);
  });

  it("科目をまたいだ穴のタグを落とす", () => {
    const { accepted, rejected } = filterHoleTopicIds(
      [
        { topic_id: "EG-JISEI-GENZAI-KANRYO", desc: "完了の意味で説明が止まった" },
        { topic_id: "M2-ZUKEI-ENCHOKU", desc: "判別式で説明が止まった" },
      ],
      grammar,
    );
    expect(accepted).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: "topic_not_allowed" });
  });
});
