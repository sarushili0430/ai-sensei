import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { isClosingUtterance } from "./closing.ts";
import { readSessionContext } from "./context.ts";
import {
  reviewOpening,
  senpaiBoardLessonPrompt,
  startsWithBoardLesson,
  timeUpClosing,
  wroteOnBoard,
} from "./senpai.ts";
import { problemPhotoBridge, problemPhotoFailedBridge } from "./session-control.ts";
import { sessionMetadataJson } from "./test-support.ts";

/**
 * 「小テストで詰まる → 先輩を呼ぶ → 板書で教え直す」を、agent が実際に判断に使う
 * 関数で固定する。
 *
 * プロンプト本文だけを検査しても、`agent.ts` が `review` を会話分岐へ送ったままなら
 * 板書は1行も開かない。入口(どこから板書を開くか)と出口(どう降りるか)を
 * 同じ復習文脈で見るのは、その2つを別々の緑色のテストにして
 * 間の配線を見失わないため。
 *
 * **教え返しの受け渡し(`teachBackFallback`)のテストはここにあった。**
 * ADR 0009 で教え返しごと畳んだので、出口の検査は「時間切れの締めの一言」に
 * 置き換えてある。降ろすのは先輩の言い方ではなく、生徒の「わかった」と残り時間だけ。
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

  /**
   * **時間切れが事故に見えないための唯一の手当て。**
   *
   * 回数の上限(6周)を外したので、天井は残り時間だけになった。ここで一言
   * 言わずに降りると、`waitForEnd` の `timeout` が会話の途中で部屋を閉じ、
   * 生徒には**説明の途中で先輩が消えた**ようにしか見える。
   */
  it("残り時間で降りるときの締めを日英で持つ", () => {
    expect(timeUpClosing("ja")).toContain("今日はここまで");
    expect(timeUpClosing("en")).toContain("stop here for today");
  });

  /**
   * 締めの文言は `closing.ts` の検出パターンと**同じ形**にしてある。
   * 会話LLMが自分で締めた縮退経路と、コードが直接TTSへ渡すこの一言とで、
   * 生徒に届く言葉を1つに保つため。
   */
  it("締めの一言は、会話LLMの締め検出と同じ形をしている", () => {
    expect(isClosingUtterance(timeUpClosing("ja"))).toBe(true);
    expect(isClosingUtterance(timeUpClosing("en"))).toBe(true);
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
