import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  senpaiBoardLessonPrompt,
  startsWithBoardLesson,
  teachBackFallback,
  teachBackPrompt,
} from "./senpai.ts";
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
if (reviewHole === null) throw new Error("復習テストの文脈に review_hole がありません");

function step(speech: string): BoardStep {
  return {
    index: 0,
    speech,
    board: { kind: "latex", tex: "x^2 + 6x = (x + 3)^2 - 9" },
  };
}

describe("復習から板書授業への接続", () => {
  it("review を冒頭から板書へ送り、写真の代わりに対象穴を根拠にする", () => {
    expect(startsWithBoardLesson(reviewContext)).toBe(true);

    const prompt = senpaiBoardLessonPrompt({ context: reviewContext, remainingSeconds: 900 });
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
});
