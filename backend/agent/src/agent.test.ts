import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  reviewOpening,
  senpaiBoardLessonPrompt,
  startsWithBoardLesson,
  teachBackFallback,
  teachBackPrompt,
  wroteOnBoard,
} from "./senpai.ts";
import { sessionMetadataJson } from "./test-support.ts";

/**
 * Pins the lower half of plan §2 ("stuck on the quiz -> call the senpai -> be
 * retaught on the board -> teach it back") using the functions the agent
 * actually decides with.
 *
 * Checking prompt text alone would miss `agent.ts` still routing `review` to the
 * conversation branch, opening no board at all. Checking only the start branch
 * would miss falling back to "taught and done" when the board LLM forgets to
 * hand over the turn. Entry and exit are checked in the same review context so
 * they do not become two green tests with the wiring between them unwatched.
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

// The pre-addition API omits the key entirely rather than sending null.
// `sessionMetadataJson` drops undefined keys with the same JSON encoding as the real API.
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

    const prompt = senpaiBoardLessonPrompt({ context: reviewContext, remainingSeconds: 900 });
    expect(prompt).toContain("review");
    expect(prompt).toContain(reviewHole.desc);
    expect(prompt).toContain(reviewHole.evidence);
    expect(prompt).toContain("M1-NIJI-GURAFU");
    // The problem text is not overwritten by the hole. "No photo" stays a fact the review branch ignores.
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
   * The failure as reported (2026-08-12).
   *
   *   senpai: "問題、読んでもらってもいい?"
   *   senpai: "じゃあ今の、自分の言葉で説明してみて。"  <- appended unconditionally
   *
   * A lesson whose problem text was unreadable asks for it to be read aloud, per
   * the board prompt. Reading that as "the turn was not handed over" - while also
   * not checking that nothing was written to the board - asked a student who had
   * been taught nothing yet to explain it. And since the conversation prompt is
   * pinned to "current activity: teach-back", the same exchange then repeats.
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
