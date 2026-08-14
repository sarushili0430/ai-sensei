import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  handsTurnToStudent,
  lessonFailedPrompt,
  lessonRecapMaxLength,
  renderLessonRecap,
  reviewOpening,
  senpaiConversationPrompt,
  teachBackPrompt,
} from "./senpai.ts";
import { sessionMetadataJson } from "./test-support.ts";

/**
 * Tests for the parts of the teach-back phase that can only live in the agent.
 *
 * Persona and promise checks live in `packages/prompts` (the source of truth).
 * Two things are checked here:
 *
 *   1. fixed lines come out per language, without breaking a promise
 *   2. the board summary lands in `lesson_recap` alongside §2's disclaimer
 */

const context = readSessionContext(
  sessionMetadataJson({
    session_id: "ses_1",
    problem_text: "x^2 - 3x + 2 = 0 を解け",
    max_seconds: 900,
    photo_summary: "円と直線の位置関係",
    visible_work: "- 中心と直線の距離を求めている",
    question_seeds: "",
    allowed_topics: "- M2-ZUKEI-ENCHOKU",
    allowed_topic_ids: ["M2-ZUKEI-ENCHOKU"],
  }),
);

/** An English session with only the problem photographed, no notes (§4-1's supported path). */
const englishContext = readSessionContext(
  sessionMetadataJson({
    session_id: "ses_2",
    problem_text: "Solve x^2 - 3x + 2 = 0",
    locale: "en",
    max_seconds: 900,
    photo_summary: "",
    visible_work: "(no photo of their notes)",
    question_seeds: "",
    allowed_topics: "",
    allowed_topic_ids: ["M2-ZUKEI-ENCHOKU"],
  }),
);

const step = (index: number, speech: string, board: BoardStep["board"]): BoardStep => ({
  index,
  speech,
  board,
});

describe("定型の一言", () => {
  it("言語ごとに別の文言を返す", () => {
    expect(teachBackPrompt("ja")).not.toBe(teachBackPrompt("en"));
    expect(lessonFailedPrompt("ja")).not.toBe(lessonFailedPrompt("en"));
    expect(reviewOpening("ja")).not.toBe(reviewOpening("en"));
    expect(lessonFailedPrompt("ja", "review")).not.toBe(lessonFailedPrompt("en", "review"));
  });

  // Saying "now explain that back to me" after not one board line came out asks
  // the student to explain something they were never taught
  it("板書が出せなかったときは、教え返しを求めない", () => {
    expect(lessonFailedPrompt("ja")).not.toContain("説明してみて");
  });

  /**
   * Fixed lines never pass through the conversation LLM, so the prompt's promises
   * do not apply. This is the only brake.
   *
   * - "make them do it, not report it": "remember?" can be answered with "yes"
   * - promise 4 (post-revision): no commands, no nagging, no numbers
   */
  it("こちらから言う一言が、申告させる聞き方や催促になっていない", () => {
    const lines = [
      teachBackPrompt("ja"),
      lessonFailedPrompt("ja"),
      reviewOpening("ja"),
      lessonFailedPrompt("ja", "review"),
    ];

    for (const line of lines) {
      expect(line, line).not.toMatch(/覚えてる|わかった\?|大丈夫\?/);
      expect(line, line).not.toMatch(/しなよ|しなさい|やらないと|急いで|残り\d/);
    }
  });
});

describe("handsTurnToStudent", () => {
  // Always true for a successful lesson (`senpai_board.*.md` instructs it at the end)
  it("最後の手順がもう番を渡していれば true", () => {
    expect(handsTurnToStudent("じゃあ今の、自分の言葉で説明してみて。", "ja")).toBe(true);
    expect(handsTurnToStudent("最初の一手、言ってみて。", "ja")).toBe(true);
    expect(handsTurnToStudent("Now explain that back to me in your own words.", "en")).toBe(true);
  });

  it("まだ先輩が喋っている途中なら false", () => {
    expect(handsTurnToStudent("じゃあ判別式のとこから。この形だったよね。", "ja")).toBe(false);
    expect(handsTurnToStudent("Here is the discriminant.", "en")).toBe(false);
    expect(handsTurnToStudent("   ", "ja")).toBe(false);
  });

  /**
   * A failure actually hit in production. A lesson whose problem text was
   * unreadable starts with "could you read the problem out?" (per
   * `senpai_board.*.md`). Reading that as "still mid-sentence" appends the
   * teach-back line right after, so the moment after being asked to read aloud,
   * the student is asked to explain what they have not been taught.
   */
  it("問いかけで終わっていれば、形が違っても番は渡っている", () => {
    expect(handsTurnToStudent("問題、読んでもらってもいい?", "ja")).toBe(true);
    expect(handsTurnToStudent("この式、まず何する?", "ja")).toBe(true);
    // A full-width question mark. Almost all Japanese output uses it, and missing
    // it rolls turn taking fully back for Japanese lessons (a full-width `？` in
    // the regex was once flattened to half-width). Written as a code point so it
    // still fails loudly if mangled.
    expect(handsTurnToStudent("D はプラスだよね。だから\uFF1F", "ja")).toBe(true);
    expect(handsTurnToStudent("じゃあ、次はどうする\uFF1F ", "ja")).toBe(true);
    expect(handsTurnToStudent("Could you read me the problem?", "en")).toBe(true);
  });

  it("文の途中の疑問符では止めない(終わりだけを見る)", () => {
    expect(handsTurnToStudent("「なんで?」って思うよね。ここを見てほしい。", "ja")).toBe(false);
  });
});

describe("renderLessonRecap", () => {
  it("板書の種類ごとに1行で書き下す", () => {
    const recap = renderLessonRecap(
      [
        step(0, "この形だったよね。", { kind: "latex", tex: "D = b^2 - 4ac" }),
        step(1, "つまり、こう。", { kind: "text", body: "D > 0 → 異なる2つの実数解" }),
        step(2, "グラフにするとこう。", {
          kind: "plot",
          fn: "x^2 - 3*x + 2",
          domain: { min: -1, max: 4 },
        }),
        step(3, "じゃあ説明してみて。", null),
      ],
      "ja",
    );

    expect(recap.split("\n")).toEqual([
      "1. 「この形だったよね。」 / 板書: D = b^2 - 4ac",
      "2. 「つまり、こう。」 / 板書: D > 0 → 異なる2つの実数解",
      "3. 「グラフにするとこう。」 / 板書: y = x^2 - 3*x + 2 (-1 .. 4)",
      "4. 「じゃあ説明してみて。」",
    ]);
  });

  // instructions are resent in full every turn. One board holds up to 40 steps, so
  // without a cap every turn pays board-sized input tokens.
  it("上限を超えたら末尾を落とす(先頭は残す)", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      step(index, "あ".repeat(100), { kind: "latex", tex: "x = 1" }),
    );

    const recap = renderLessonRecap(many, "ja");

    expect(recap.length).toBeLessThanOrEqual(lessonRecapMaxLength);
    expect(recap).toContain("1. 「");
    expect(recap).not.toContain("40. 「");
  });

  // Returning an empty string leaves a heading-only section for the senpai to read,
  // which can be read as "there is a board but it is unreadable". State the absence.
  it("授業前は「まだ無い」と書いた定型句を、会話の言語で返す", () => {
    expect(renderLessonRecap([], "ja")).toContain("まだ板書には何も出していません");
    expect(renderLessonRecap([], "en")).toContain("nothing on the board yet");
    expect(renderLessonRecap([], "en")).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

describe("senpaiConversationPrompt", () => {
  // Persona and promise content is checked against the source (prompts/senpai_conversation.*.md).
  // Here we only check that the source is actually used.
  it("先輩の正本を使う(後輩の人物像は残っていない)", () => {
    const prompt = senpaiConversationPrompt({ context, remainingSeconds: 600 });

    expect(prompt).toContain("ユーザー(高校生)の**先輩**です");
    expect(prompt).not.toContain("**後輩**です");
  });

  it("会話の文脈と残り時間が埋まっている", () => {
    const prompt = senpaiConversationPrompt({ context, remainingSeconds: 600 });

    expect(prompt).toContain("円と直線の位置関係");
    expect(prompt).toContain("M2-ZUKEI-ENCHOKU");
    expect(prompt).toContain("600");
  });

  it("授業前は「まだ板書に何も出していない」と伝える", () => {
    const prompt = senpaiConversationPrompt({ context, remainingSeconds: 900 });

    expect(prompt).toContain("まだ板書には何も出していません");
  });

  // Without knowing what was taught, the senpai cannot judge "said it / got stuck"
  it("授業のあとは板書の要約を渡す", () => {
    const prompt = senpaiConversationPrompt({
      context,
      remainingSeconds: 500,
      lesson: [step(0, "この形だったよね。", { kind: "latex", tex: "D = b^2 - 4ac" })],
    });

    expect(prompt).toContain("D = b^2 - 4ac");
  });

  // Plan §2 ("questions come from what the user explained, never from what the AI
  // taught") is written into the prompt too - handing over a summary makes it easy to break
  it("板書の要約には「ユーザーが説明できた内容ではない」が必ず添う", () => {
    const prompt = senpaiConversationPrompt({
      context,
      remainingSeconds: 500,
      lesson: [step(0, "この形だったよね。", { kind: "latex", tex: "D = b^2 - 4ac" })],
    });

    expect(prompt).toContain("ユーザーが説明できた内容ではありません");
  });

  // Never a Japanese body with "answer in English" appended (prompts/README.md)
  it("英語ロケールでは正本も定型句も英語になる", () => {
    const prompt = senpaiConversationPrompt({
      context: englishContext,
      remainingSeconds: 600,
      lesson: [step(0, "This is the shape.", { kind: "latex", tex: "D = b^2 - 4ac" })],
    });

    expect(prompt).toContain("You are the user's **senpai**");
    expect(prompt).toContain("It is not something the user has explained.");
    expect(prompt).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});
