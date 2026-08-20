import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  practiceTeachBackPrompt,
  reviewOpening,
  senpaiBoardLessonPrompt,
  startsWithBoardLesson,
  teachBackFallback,
  teachBackPrompt,
  wroteOnBoard,
} from "./senpai.ts";
import { problemPhotoBridge, problemPhotoFailedBridge } from "./session-control.ts";
import { sessionMetadataJson } from "./test-support.ts";

/**
 * 計画書 §2 の下半分「小テストで詰まる → 先輩を呼ぶ → 板書で教え直す →
 * 教え返す」を、agent が実際に判断に使う関数で固定する。
 *
 * プロンプト本文だけを検査しても、`agent.ts` が `review` を会話分岐へ送ったままなら
 * 板書は1行も開かない。逆に開始分岐だけを検査しても、板書LLMが番を渡し忘れたとき
 * 「教えて終わり」に戻れる。入口と出口を同じ復習文脈で見るのは、その2つを
 * 別々の緑色のテストにして間の配線を見失わないため。
 */

const reviewContext = readSessionContext(
  sessionMetadataJson({
    session_id: "ses_review",
    locale: "ja",
    kind: "review",
    max_seconds: 1200,
    photo_summary: "前回、平方完成が頂点を表す理由で説明が止まった",
    problem_text: "(問題の写真なし)",
    visible_work: "(なし)",
    question_seeds: "- 平方完成が頂点を表す理由で説明が止まった",
    allowed_topics:
      "- M1-NIJI-GURAFU — 数学I / 二次関数 / 二次関数のグラフと平方完成\n    - 平方完成が何のための変形かを説明できる",
    allowed_topic_ids: ["M1-NIJI-GURAFU"],
    is_premium: true,
    review_hole: {
      topic_id: "M1-NIJI-GURAFU",
      desc: "平方完成が頂点を表す理由で説明が止まった",
      evidence: "形をそろえるため、だと思う",
    },
  }),
);
const reviewHole = reviewContext.review_hole;
if (reviewHole == null) throw new Error("復習テストの文脈に review_hole がありません");

// 追加前のAPIは null ではなく、キーそのものを送らない。
// `sessionMetadataJson` は実際のAPIと同じJSON化で undefined のキーを省く。
const legacyReviewContext = readSessionContext(
  sessionMetadataJson({
    session_id: "ses_legacy_review",
    locale: "ja",
    kind: "review",
    max_seconds: 1200,
    photo_summary: "前回、平方完成が頂点を表す理由で説明が止まった",
    problem_text: "(問題の写真なし)",
    visible_work: "(なし)",
    question_seeds: "- 平方完成が頂点を表す理由で説明が止まった",
    allowed_topics: "- M1-NIJI-GURAFU",
    allowed_topic_ids: ["M1-NIJI-GURAFU"],
    is_premium: true,
    review_hole: undefined,
  }),
);

function step(speech: string): BoardStep {
  return {
    index: 0,
    speech,
    board: { kind: "latex", tex: "x^2 + 6x = (x + 3)^2 - 9" },
  };
}

describe("復習から板書授業への接続", () => {
  it("古いAPIの欄なしreviewを読み、板書なしの聞き直し会話へ落とす", () => {
    expect(legacyReviewContext.review_hole).toBeUndefined();
    expect(startsWithBoardLesson(legacyReviewContext)).toBe(false);
    expect(reviewOpening(legacyReviewContext.locale)).toContain("もう一回説明してみて");
  });

  it("review を冒頭から板書へ送り、写真の代わりに対象穴を根拠にする", () => {
    expect(startsWithBoardLesson(reviewContext)).toBe(true);

    const prompt = senpaiBoardLessonPrompt({ context: reviewContext });
    expect(prompt).toContain("review");
    expect(prompt).toContain(reviewHole.desc);
    expect(prompt).toContain(reviewHole.evidence);
    expect(prompt).toContain("M1-NIJI-GURAFU");
    // 問題文を穴で上書きしていない。写真なしは事実として残し、review 分岐が無視する。
    expect(prompt).toContain("(問題の写真なし)");
  });

  it("教えた手順が番を渡し忘れても、必ず教え返しへ戻す", () => {
    const fallback = teachBackFallback(reviewContext, [step("この形にすると頂点が見えるよ。")]);
    expect(fallback).toBe(teachBackPrompt("ja"));
    expect(fallback).toContain("自分の言葉で説明してみて");
  });

  it("板書がすでに教え返しへ渡していれば、同じ問いを二重に足さない", () => {
    expect(
      teachBackFallback(reviewContext, [step("じゃあ今の、自分の言葉で説明してみて。")]),
    ).toBeNull();
  });

  /**
   * **報告された壊れ方(2026-08-12)。**
   *
   *   先輩「問題、読んでもらってもいい?」
   *   先輩「じゃあ今の、自分の言葉で説明してみて。」  ← これが無条件で足されていた
   *
   * 問題文が写真から読めなかった授業は、板書プロンプトの指示どおり読み上げを頼む。
   * それを「番を渡していない」と読んだうえに、板書に1行も書いていないことも
   * 見ていなかったので、**まだ何も教わっていない生徒に説明を求めていた。**
   * しかも会話プロンプトは「いまやっていること — 教え返し」で固定なので、
   * そのまま同じやりとりが繰り返される。
   */
  it("問題文の読み上げを頼んだだけの回に、教え返しを足さない", () => {
    const asked: BoardStep = { index: 0, speech: "問題、読んでもらってもいい?", board: null };
    expect(teachBackFallback(reviewContext, [asked])).toBeNull();
  });

  it("板書に1行も書いていない回には足さない(「今の」が存在しない)", () => {
    const spoken: BoardStep = { index: 0, speech: "じゃあ、そこから見ていくね。", board: null };
    expect(teachBackFallback(reviewContext, [spoken])).toBeNull();
  });

  it("1行でも書いていれば、これまでどおり教え返しへ戻す", () => {
    expect(
      teachBackFallback(reviewContext, [
        { index: 0, speech: "まず、そこは置いといて。", board: null },
        step("この形にすると頂点が見えるよ。"),
      ]),
    ).toBe(teachBackPrompt("ja"));
  });

  it("類題まで出したあとに受け渡しを忘れたら、その類題の理由説明へ戻す", () => {
    const solving: BoardStep = {
      index: 1,
      speech: "じゃあ、この類題はどうなる?",
      board: { kind: "latex", tex: "x^2 - 5x + 6 = 0" },
      awaits_solving: true,
    };
    const answered: BoardStep = {
      index: 2,
      speech: "正答はこう。",
      board: { kind: "text", body: "異なる2つの実数解" },
    };

    expect(teachBackFallback(reviewContext, [solving, answered])).toBe(
      practiceTeachBackPrompt("ja"),
    );
  });

  it("できなかった後の教え直しを、類題の正答を書けた分岐とは扱わない", () => {
    const solving: BoardStep = {
      index: 1,
      speech: "じゃあ、この類題はどうなる?",
      board: { kind: "latex", tex: "x^2 - 5x + 6 = 0" },
      awaits_solving: true,
    };
    const askedWhere: BoardStep = {
      index: 2,
      speech: "そっか。どこで止まった?",
      board: null,
      awaits_student: true,
    };
    const retaught = step("まずDに数字を入れるところを一緒にやろう。");

    expect(teachBackFallback(reviewContext, [solving, askedWhere, retaught])).toBe(
      teachBackPrompt("ja"),
    );
  });
});

describe("板書に何か書いたか", () => {
  it("音声だけの手順は「教えた」に数えない", () => {
    expect(wroteOnBoard([{ index: 0, speech: "うん、そうそう。", board: null }])).toBe(false);
    expect(wroteOnBoard([])).toBe(false);
  });

  it("1つでも板書に載っていれば true", () => {
    expect(wroteOnBoard([{ index: 0, speech: "ここ。", board: null }, step("こう。")])).toBe(true);
  });
});

describe("会話中の追加写真", () => {
  it("解析中と失敗時のつなぎを日英で持つ", () => {
    expect(problemPhotoBridge("ja")).toContain("ちょっと待って");
    expect(problemPhotoBridge("en")).toContain("moment");
    expect(problemPhotoFailedBridge("ja")).toContain("今の問題");
    expect(problemPhotoFailedBridge("en")).toContain("current problem");
  });
});
