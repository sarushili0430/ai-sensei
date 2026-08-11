import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  handsTurnToStudent,
  lessonFailedPrompt,
  lessonRecapMaxLength,
  openingFiller,
  renderLessonRecap,
  reviewOpening,
  senpaiConversationPrompt,
  teachBackPrompt,
} from "./senpai.ts";
import { sessionMetadataJson } from "./test-support.ts";

/**
 * 教え返しフェーズのうち、**agent 側にしか置けないもの**のテスト。
 *
 * 人格と約束の検査は `packages/prompts` 側(正本がそこにあるため)。
 * ここで見るのは2つ:
 *
 *   1. 定型の一言が、言語ごとに・約束を破らない形で出ること
 *   2. 板書の要約が `lesson_recap` に入り、§2 の断り書きと一緒に出ること
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

/** ノートを撮らずに問題だけを持ってきた、英語のセッション(§4-1 の正規の経路)。 */
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
    expect(openingFiller("ja")).not.toBe(openingFiller("en"));
    expect(teachBackPrompt("ja")).not.toBe(teachBackPrompt("en"));
    expect(lessonFailedPrompt("ja")).not.toBe(lessonFailedPrompt("en"));
    expect(reviewOpening("ja")).not.toBe(reviewOpening("en"));
  });

  // 板書が1行も出せなかったのに「じゃあ今の、説明してみて」と言うと、
  // 教わっていないことの説明を求めることになる
  it("板書が出せなかったときは、教え返しを求めない", () => {
    expect(lessonFailedPrompt("ja")).not.toContain("説明してみて");
  });

  /**
   * 定型の一言は**会話LLMを通らない**ので、プロンプトの約束が効かない。
   * ここが唯一の歯止め。
   *
   * - 【申告させず、やらせる】: 「覚えてる?」は「うん」で返せてしまう
   * - 約束4(改正後): 命令・催促・数字を出さない
   */
  it("こちらから言う一言が、申告させる聞き方や催促になっていない", () => {
    const lines = [
      openingFiller("ja"),
      teachBackPrompt("ja"),
      lessonFailedPrompt("ja"),
      reviewOpening("ja"),
    ];

    for (const line of lines) {
      expect(line, line).not.toMatch(/覚えてる|わかった\?|大丈夫\?/);
      expect(line, line).not.toMatch(/しなよ|しなさい|やらないと|急いで|残り\d/);
    }
  });
});

describe("handsTurnToStudent", () => {
  // 成功した授業では毎回そうなる(`senpai_board.*.md` が最後にそう指示している)
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

  // instructions は毎ターン全部送られる。板書1枚は最大40手順あるので、
  // 上限がないと会話のたびに板書ぶんの入力トークンを払い続けることになる。
  it("上限を超えたら末尾を落とす(先頭は残す)", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      step(index, "あ".repeat(100), { kind: "latex", tex: "x = 1" }),
    );

    const recap = renderLessonRecap(many, "ja");

    expect(recap.length).toBeLessThanOrEqual(lessonRecapMaxLength);
    expect(recap).toContain("1. 「");
    expect(recap).not.toContain("40. 「");
  });

  // 空文字を返すと、見出しだけが残った節を先輩が読むことになり、
  // 「板書はあるが読めない」と解釈されうる。**無いことを書く。**
  it("授業前は「まだ無い」と書いた定型句を、会話の言語で返す", () => {
    expect(renderLessonRecap([], "ja")).toContain("まだ板書には何も出していません");
    expect(renderLessonRecap([], "en")).toContain("nothing on the board yet");
    expect(renderLessonRecap([], "en")).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

describe("senpaiConversationPrompt", () => {
  // 人格・約束の中身は正本(prompts/senpai_conversation.*.md)側で見る。
  // ここで見るのは「正本がちゃんと使われているか」だけ。
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

  // 先輩が「何を教えたか」を知らないと、教え返しの「言えた / 詰まった」が判定できない
  it("授業のあとは板書の要約を渡す", () => {
    const prompt = senpaiConversationPrompt({
      context,
      remainingSeconds: 500,
      lesson: [step(0, "この形だったよね。", { kind: "latex", tex: "D = b^2 - 4ac" })],
    });

    expect(prompt).toContain("D = b^2 - 4ac");
  });

  // 計画書 §2「出題元はユーザーが説明した内容。AIが教えた内容から作らない」を
  // プロンプト側にも二重に書く。要約を渡した瞬間に破りやすくなる約束なので
  it("板書の要約には「ユーザーが説明できた内容ではない」が必ず添う", () => {
    const prompt = senpaiConversationPrompt({
      context,
      remainingSeconds: 500,
      lesson: [step(0, "この形だったよね。", { kind: "latex", tex: "D = b^2 - 4ac" })],
    });

    expect(prompt).toContain("ユーザーが説明できた内容ではありません");
  });

  // 日本語の本文に「英語で答えて」を足す作りにしない(prompts/README.md)
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
