import type { BoardStep } from "@ai-sensei/contract";
import { formatProblemText } from "@ai-sensei/prompts";
import { describe, expect, it } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  type LessonTurn,
  asksForBoard,
  asksForProblemReadout,
  asksForTeachBack,
  classifySolvingReport,
  handsTurnToStudent,
  lessonContinuationInstruction,
  lessonFailedPrompt,
  lessonRecapMaxLength,
  practiceTeachBackPrompt,
  problemTextIsMissing,
  rememberSpokenProblemText,
  renderLessonRecap,
  reviewOpening,
  senpaiBoardLessonPrompt,
  senpaiBoardRemainingNote,
  senpaiConversationPrompt,
  stepAwaitsInput,
  stepAwaitsSolving,
  stepAwaitsStudent,
  studentSilenceMarker,
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

const step = (index: number, speech: string, board: BoardStep["board"]): LessonTurn => ({
  kind: "step",
  step: { index, speech, board },
});

const said = (text: string): LessonTurn => ({ kind: "student", text });

describe("定型の一言", () => {
  it("言語ごとに別の文言を返す", () => {
    expect(teachBackPrompt("ja")).not.toBe(teachBackPrompt("en"));
    expect(practiceTeachBackPrompt("ja")).not.toBe(practiceTeachBackPrompt("en"));
    expect(lessonFailedPrompt("ja")).not.toBe(lessonFailedPrompt("en"));
    expect(reviewOpening("ja")).not.toBe(reviewOpening("en"));
    expect(lessonFailedPrompt("ja", "review")).not.toBe(lessonFailedPrompt("en", "review"));
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
      teachBackPrompt("ja"),
      practiceTeachBackPrompt("ja"),
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

  /**
   * **実際に踏んだ壊れ方。** 問題文が読めなかった授業は
   * 「問題、読んでもらってもいい?」から始まる(`senpai_board.*.md` の指示)。
   * これを「まだ喋っている途中」と読むと、直後に教え返しの定型句が足され、
   * **読み上げを頼まれた次の瞬間に、まだ教わっていない内容の説明を求められる。**
   */
  it("問いかけで終わっていれば、形が違っても番は渡っている", () => {
    expect(handsTurnToStudent("問題、読んでもらってもいい?", "ja")).toBe(true);
    expect(handsTurnToStudent("この式、まず何する?", "ja")).toBe(true);
    // **全角の疑問符。**日本語の出力はほとんどこちらで、ここを取りこぼすと
    // 日本語の授業ではターン制が丸ごと元に戻る(実際に一度、正規表現の中の
    // 全角 `？` が半角に潰れていた)。半角に化けても落ちるよう、
    // コードポイントで書いてある。
    expect(handsTurnToStudent("D はプラスだよね。だから\uFF1F", "ja")).toBe(true);
    expect(handsTurnToStudent("じゃあ、次はどうする\uFF1F ", "ja")).toBe(true);
    expect(handsTurnToStudent("Could you read me the problem?", "en")).toBe(true);
  });

  it("文の途中の疑問符では止めない(終わりだけを見る)", () => {
    expect(handsTurnToStudent("「なんで?」って思うよね。ここを見てほしい。", "ja")).toBe(false);
  });
});

describe("stepAwaitsStudent", () => {
  const withField = (speech: string, awaits: boolean | undefined) => ({
    speech,
    ...(awaits === undefined ? {} : { awaits_student: awaits }),
  });

  /**
   * 言い回しの推測が取りこぼす問いかけこそ、申告で止まらないといけない。
   * 「まず何する? 一言でいいよ。」は**板書プロンプトの見本そのもの**で、
   * `?` が文中に沈むので `handsTurnToStudent` は false — 推測のままだと
   * ここで授業ループが「渡し忘れ」と誤読して1パス目で終わり、
   * 板書が最初の数行のまま二度と増えなくなる(実際に起きた壊れ方)。
   */
  it("申告があれば言い回しに関わらず従う", () => {
    const missedByRegex = "オッケー。じゃあこの式、まず何する? 一言でいいよ。";
    expect(handsTurnToStudent(missedByRegex, "ja")).toBe(false);
    expect(stepAwaitsStudent(withField(missedByRegex, true), "ja")).toBe(true);

    // 逆向き: 修辞疑問は末尾が ? でも false の申告で流す(#105 の症状A)。
    const rhetorical = "まず(1)からやろっか?";
    expect(handsTurnToStudent(rhetorical, "ja")).toBe(true);
    expect(stepAwaitsStudent(withField(rhetorical, false), "ja")).toBe(false);
  });

  it("欄が無い手順は従来の言い回し判定に落ちる(修復経路・古い出力)", () => {
    expect(stepAwaitsStudent(withField("この式、まず何する?", undefined), "ja")).toBe(true);
    expect(stepAwaitsStudent(withField("この形だったよね。", undefined), "ja")).toBe(false);
  });
});

describe("問題文の音読", () => {
  it.each([
    ["問題、読んでもらってもいい?", "ja"],
    ["問題文を読み上げてくれる?", "ja"],
    ["Can you read the question out to me?", "en"],
    ["Tell me what the problem says.", "en"],
  ] as const)("音読を頼む発話だけを拾う: %s", (speech, locale) => {
    expect(asksForProblemReadout(speech, locale)).toBe(true);
  });

  it("ふつうの切り分け質問を音読と取り違えない", () => {
    expect(asksForProblemReadout("この問題、まず何する?", "ja")).toBe(false);
    expect(asksForProblemReadout("What do you do first in this problem?", "en")).toBe(false);
    expect(asksForProblemReadout("問題を読んで考えてみるね。", "ja")).toBe(false);
    expect(asksForProblemReadout("I'll read the question first.", "en")).toBe(false);
  });

  /**
   * **「教えて」で終わる切り分けは、問題文が無いときこそ出る。**
   * ここを音読と取り違えると、その答え(「たぶん x を求めるやつ」)が
   * `problem_text` として居座り、以降のパスとカルテまで巻き込む。
   */
  it("「〜か教えて」の切り分けを音読依頼と取り違えない", () => {
    expect(asksForProblemReadout("この問題、何を聞かれてるか教えて", "ja")).toBe(false);
    expect(asksForProblemReadout("この問題、どこまでやったか教えて", "ja")).toBe(false);
    expect(asksForProblemReadout("問題のどこで止まったか教えて", "ja")).toBe(false);
    // 間を詰めた直接の依頼は拾えたままにする。
    expect(asksForProblemReadout("問題文、教えてもらっていい?", "ja")).toBe(true);
    expect(asksForProblemReadout("問題、ちょっと読んでもらっていい?", "ja")).toBe(true);
  });

  function missingProblemContext(locale: "ja" | "en" = "ja") {
    return readSessionContext(
      sessionMetadataJson({
        session_id: `ses_missing_${locale}`,
        locale,
        problem_text: formatProblemText(null, locale),
        allowed_topic_ids: ["M2-ZUKEI-ENCHOKU"],
      }),
    );
  }

  it("音読した問題文をメモリ上の文脈へ差し替える", () => {
    const missing = missingProblemContext();
    const spoken = "次の二次方程式 x^2 - 3x + 2 = 0 を解け。";

    expect(problemTextIsMissing(missing)).toBe(true);
    expect(rememberSpokenProblemText(missing, spoken)).toEqual({
      accepted: true,
      length: spoken.length,
    });
    expect(missing.problem_text).toBe(spoken);
    expect(problemTextIsMissing(missing)).toBe(false);
  });

  it("答えまで読まれた発話は採用せず、定型句のまま保つ", () => {
    const missing = missingProblemContext();

    expect(rememberSpokenProblemText(missing, "x を求めよ。x + 3 = 7。答え: 4")).toEqual({
      accepted: false,
      reason: "solution_included",
    });
    expect(problemTextIsMissing(missing)).toBe(true);
  });

  /**
   * **断った返事を問題文にしない。**
   *
   * 「わかりません」「読めない」は解答マーカーも式だけの断片も含まないので
   * `checkProblemText` を素通りする。そのまま採用すると、それが以降のパスと
   * カルテの `problem_text` として居座り、**問題文が無いままのほうがまだましな形**で
   * 嘘の文脈が残る。読めなかったのなら定型句のままにしておくのが正しい。
   */
  it.each([
    ["わかりません", "ja"],
    ["えっと、わかんない", "ja"],
    ["読めない", "ja"],
    ["ちょっと待って", "ja"],
    ["I can't read it", "en"],
    ["No idea", "en"],
  ] as const)("音読を断った返事は問題文にしない: %s", (spoken, locale) => {
    const missing = missingProblemContext(locale);

    expect(rememberSpokenProblemText(missing, spoken)).toEqual({
      accepted: false,
      reason: "not_a_problem",
    });
    expect(problemTextIsMissing(missing)).toBe(true);
  });

  // 文中に「わからない」が出てくるだけの問題文は通す(先頭だけを見ているため)。
  it("「わからない」を含む問題文そのものは採用する", () => {
    const missing = missingProblemContext();
    const spoken = "x がわからないときの解き方を求めよ。";

    expect(rememberSpokenProblemText(missing, spoken)).toMatchObject({ accepted: true });
    expect(missing.problem_text).toBe(spoken);
  });

  it("600字を超えた発話は途中で切らずに採用しない", () => {
    const missing = missingProblemContext();
    const tooLong = `次の値を求めよ。${"あ".repeat(600)}`;

    expect(rememberSpokenProblemText(missing, tooLong)).toEqual({
      accepted: false,
      reason: "too_long",
    });
    expect(problemTextIsMissing(missing)).toBe(true);
  });

  it("既に読めている問題文を後続の発話で上書きしない", () => {
    const original = context.problem_text;
    expect(rememberSpokenProblemText(context, "別の問題を解け。")).toEqual({
      accepted: false,
      reason: "already_present",
    });
    expect(context.problem_text).toBe(original);
  });
});

describe("類題の解答待ち", () => {
  it("通常の問いとは別の申告として読む", () => {
    const solving = {
      speech: "じゃあ、この類題はどうなる?",
      awaits_student: false,
      awaits_solving: true,
    };
    expect(stepAwaitsSolving(solving)).toBe(true);
    expect(stepAwaitsInput(solving, "ja")).toBe(true);
    expect(stepAwaitsStudent(solving, "ja")).toBe(false);
  });

  it("ボタンと声の言い換えを同じ本人申告へ分類し、否定形を先に見る", () => {
    expect(classifySolvingReport("できた", "ja")).toBe("solved");
    expect(classifySolvingReport("解けました", "ja")).toBe("solved");
    expect(classifySolvingReport("できなかった", "ja")).toBe("stuck");
    expect(classifySolvingReport("できませんでした", "ja")).toBe("stuck");
    expect(classifySolvingReport("解けない", "ja")).toBe("stuck");
    expect(classifySolvingReport("わかんない", "ja")).toBe("stuck");
    expect(classifySolvingReport("I got it", "en")).toBe("solved");
    expect(classifySolvingReport("I couldn't do it", "en")).toBe("stuck");
    expect(classifySolvingReport("I can't solve it", "en")).toBe("stuck");
    expect(classifySolvingReport("答えは2つ", "ja")).toBe("unclear");
  });

  /**
   * 声で答える生徒は言い切りより「まだできてない」と言う。ここを落とすと
   * `unclear` へ沈み、はっきり詰まりを伝えた生徒に「できた? 止まった?」と
   * もう一度言わせることになる。
   */
  it("「〜できてない」も詰まりとして拾う", () => {
    expect(classifySolvingReport("まだできてない", "ja")).toBe("stuck");
    expect(classifySolvingReport("えっと、解けてない", "ja")).toBe("stuck");
    expect(classifySolvingReport("まだできてません", "ja")).toBe("stuck");
  });
});

describe("asksForBoard", () => {
  it("板書・黒板と名指しした発話だけを拾う", () => {
    expect(asksForBoard("板書して!", "ja")).toBe(true);
    expect(asksForBoard("それ、黒板に書いてみて", "ja")).toBe(true);
    expect(asksForBoard("板書のここの部分がわからない", "ja")).toBe(true);
    expect(asksForBoard("Can you write it on the board?", "en")).toBe(true);
    expect(asksForBoard("Put that on the whiteboard please", "en")).toBe(true);
  });

  /**
   * 「書いて」だけでは拾わない。教え返しの説明そのもの
   * (「ここで式を書いて解く」)が授業へ吸い込まれると、
   * 生徒の説明の途中に先輩の板書パスが割り込む。
   */
  it("板書と名指ししない発話は拾わない(説明の誤爆を避ける)", () => {
    expect(asksForBoard("ここで式を書いて解くんだよね", "ja")).toBe(false);
    expect(asksForBoard("次はどうするんだっけ", "ja")).toBe(false);
    expect(asksForBoard("I'm a bit bored of this", "en")).toBe(false);
  });
});

describe("asksForTeachBack", () => {
  // 授業の往復を終える唯一の合図。板書プロンプトが最後の手順に固定している文言の族。
  it("教え返しへの受け渡しだけを true にする", () => {
    expect(asksForTeachBack("じゃあ今の、自分の言葉で説明してみて。", "ja")).toBe(true);
    expect(asksForTeachBack(teachBackPrompt("ja"), "ja")).toBe(true);
    expect(asksForTeachBack(teachBackPrompt("en"), "en")).toBe(true);
    expect(asksForTeachBack(practiceTeachBackPrompt("ja"), "ja")).toBe(true);
    expect(asksForTeachBack(practiceTeachBackPrompt("en"), "en")).toBe(true);
    expect(asksForTeachBack("Now explain that back to me in your own words.", "en")).toBe(true);
  });

  /**
   * 途中の問いかけは番を渡すが(`handsTurnToStudent` は true)、授業は終わらない。
   * ここを取り違えると、質問を1つしただけで板書の続きが書けなくなる —
   * 「先輩がすぐ説明を投げてくる」というドッグフーディングの報告の形そのもの。
   */
  it("途中の問いかけでは終わらない", () => {
    for (const speech of [
      "最小公倍数、何になると思う?",
      "この式の a と b と c、どれ?",
      "最初の一手、言ってみて。",
      "これ、まず何する?",
    ]) {
      expect(asksForTeachBack(speech, "ja"), speech).toBe(false);
      expect(handsTurnToStudent(speech, "ja"), speech).toBe(true);
    }
    expect(asksForTeachBack("What do you think the LCM is?", "en")).toBe(false);
    expect(asksForTeachBack("", "ja")).toBe(false);
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

  /**
   * 往復した授業では、生徒の答えも要約に入る。ここが無いと、会話LLMは
   * 「最小公倍数、何になると思う?」に生徒がもう答えたことを知らず、
   * **同じ質問をもう一度聞く**ところから教え返しが始まる。
   */
  it("生徒の発話をロール名つきで挟む", () => {
    const recap = renderLessonRecap(
      [
        step(0, "最小公倍数、何になると思う?", null),
        said("12だと思う"),
        step(1, "そう、12だよね。", { kind: "latex", tex: "x = 12" }),
      ],
      "ja",
    );

    expect(recap.split("\n")).toEqual([
      "1. 「最小公倍数、何になると思う?」",
      "ユーザー: 「12だと思う」",
      "2. 「そう、12だよね。」 / 板書: x = 12",
    ]);
  });

  it("英語では英語のロール名と引用符になる", () => {
    const recap = renderLessonRecap(
      [step(0, "What do you think the LCM is?", null), said("Twelve, I think")],
      "en",
    );

    expect(recap.split("\n")).toEqual([
      '1. "What do you think the LCM is?"',
      'Student: "Twelve, I think"',
    ]);
    expect(recap).not.toMatch(/[ぁ-んァ-ン一-龯]/);
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

  it("上限を超えても最後の類題と正答は lesson_recap に必ず残す", () => {
    const many: LessonTurn[] = Array.from({ length: 30 }, (_, index) =>
      step(index, "あ".repeat(90), { kind: "latex", tex: "x = 1" }),
    );
    many.push({
      kind: "step",
      step: {
        index: 30,
        speech: "じゃあ、この類題はどうなる?",
        board: { kind: "latex", tex: "x^2 - 5x + 6 = 0" },
        awaits_solving: true,
      },
    });
    many.push(said("できた"));
    many.push(
      step(31, "正答はこう。", {
        kind: "text",
        body: "D = 1 > 0 → 異なる2つの実数解",
      }),
    );

    const recap = renderLessonRecap(many, "ja");

    expect(recap.length).toBeLessThanOrEqual(lessonRecapMaxLength);
    expect(recap).toContain("x^2 - 5x + 6 = 0");
    expect(recap).toContain("D = 1 > 0 → 異なる2つの実数解");
  });

  // 空文字を返すと、見出しだけが残った節を先輩が読むことになり、
  // 「板書はあるが読めない」と解釈されうる。**無いことを書く。**
  it("授業前は「まだ無い」と書いた定型句を、会話の言語で返す", () => {
    expect(renderLessonRecap([], "ja")).toContain("まだ板書には何も出していません");
    expect(renderLessonRecap([], "en")).toContain("nothing on the board yet");
    expect(renderLessonRecap([], "en")).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

describe("lessonContinuationInstruction", () => {
  const turns: LessonTurn[] = [
    step(0, "まず、式をそのまま書くね。", { kind: "latex", tex: "x^2 - 3x + 2 = 0" }),
    step(1, "最小公倍数、何になると思う?", null),
    said("えっと、12?"),
  ];

  it("ここまでのやりとりと、続きだけを書く指示が入る", () => {
    const instruction = lessonContinuationInstruction(turns, "ja");

    expect(instruction).toContain("x^2 - 3x + 2 = 0");
    expect(instruction).toContain("生徒: 「えっと、12?」");
    expect(instruction).toContain("続きだけを書きます");
    expect(instruction).toContain("`index` はまた 0 から");
  });

  it("問題文の音読を一度頼んだあとは、同じ依頼を繰り返さないよう明示する", () => {
    const instruction = lessonContinuationInstruction(
      [step(0, "問題、読んでもらってもいい?", null), said("x を求めよ。")],
      "ja",
    );

    expect(instruction).toContain("問題文の読み上げはもう一度頼みません");
  });

  it("類題の本人申告に応じた分岐指示を足す", () => {
    const solved = lessonContinuationInstruction([...turns, said("できた")], "ja", "solved");
    const stuck = lessonContinuationInstruction([...turns, said("できなかった")], "ja", "stuck");

    expect(solved).toContain("類題の正答");
    expect(solved).toContain("正解したとは言わない");
    expect(stuck).toContain("どこで止まった");
    expect(stuck).toContain("責めず");
  });

  /**
   * **行番号は板書の通し位置で振る。**
   *
   * 継続の指示は「`index` はまた 0 から数えます」なので、2パス目の手順は
   * `index` 0・1 を取り直す。それをそのまま番号にすると要約に 1・2 が二度並び、
   * 問いかけで名指しする「2行目」がどの行か決まらなくなる —— 生徒に違う行を
   * 見せる誘導になる。板書は開き直さず積み上がるので、通し位置が画面の行と一致する。
   */
  it("パスをまたいで `index` が振り直されても、行番号は板書の通し位置になる", () => {
    const acrossPasses: LessonTurn[] = [
      step(0, "まず、式をそのまま書くね。", { kind: "latex", tex: "x^2 - 3x + 2 = 0" }),
      step(1, "因数分解するとこう。", { kind: "latex", tex: "(x-1)(x-2) = 0" }),
      said("わかった"),
      // 2パス目。`index` は 0 から振り直される。
      step(0, "じゃあ解はこう。", { kind: "latex", tex: "x = 1, 2" }),
      step(1, "3行目の右辺、どっちが大きい?", { kind: "text", body: "Q: 3行目の右辺は?" }),
    ];

    const instruction = lessonContinuationInstruction(acrossPasses, "ja");

    expect(instruction).toContain("3. 「じゃあ解はこう。」");
    expect(instruction).toContain("4. 「3行目の右辺、どっちが大きい?」");
    // 1・2 が二度出てこない(2パス目が 1. から振り直されていない)。
    expect(instruction.match(/^1\. /gm) ?? []).toHaveLength(1);
    expect(instruction.match(/^2\. /gm) ?? []).toHaveLength(1);
  });

  // 答えの直前が読めないと、続きがその答えと噛み合わない。
  // 教え返しの要約(先頭を残す)とは逆で、こちらは**末尾**を残す。
  it("溢れたら先頭を落として、直近のやりとりを残す", () => {
    const many: LessonTurn[] = Array.from({ length: 60 }, (_, index) =>
      step(index, `${index}番目。${"あ".repeat(90)}`, null),
    );
    many.push(said("最後の答え"));

    const instruction = lessonContinuationInstruction(many, "ja");

    expect(instruction).toContain("最後の答え");
    expect(instruction).not.toContain("「0番目。");
  });

  it("英語では英語の指示になる", () => {
    const instruction = lessonContinuationInstruction(
      [step(0, "What do you think the LCM is?", null), said("Twelve?")],
      "en",
    );

    expect(instruction).toContain('Student: "Twelve?"');
    expect(instruction).toContain("write only what comes next");
    expect(instruction).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it("沈黙の記録は会話の言語で書かれている", () => {
    expect(studentSilenceMarker("ja")).toBe("(返事はなかった)");
    expect(studentSilenceMarker("en")).toBe("(no reply)");
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

/* -------------------------------------------------------------------------- */
/* 板書プロンプトの残り時間                                                    */
/* -------------------------------------------------------------------------- */

describe("板書プロンプトの残り時間", () => {
  /**
   * **ここが変わるとプロンプトキャッシュが毎パス外れる。**4万字級の指示文が
   * まるごと書き直しになり、TTFT(= 最初の手順までの沈黙)も原価もパスの数だけ素で払う。
   */
  it("正本は残り時間で1バイトも変わらない", () => {
    const first = senpaiBoardLessonPrompt({ context });
    const second = senpaiBoardLessonPrompt({ context });

    expect(second).toBe(first);
    // 秒数そのものが本文へ紛れ込んでいないこと(本文は「最後に書いてある」と言うだけ)。
    expect(first).toContain("いちばん最後");
  });

  it("残り時間はロケールに合わせた1行で出す", () => {
    expect(senpaiBoardRemainingNote(540, "ja")).toBe("この授業の残り時間は 540 秒です。");
    expect(senpaiBoardRemainingNote(540, "en")).toBe("You have 540 seconds left in this lesson.");
  });

  /** 「-30秒」を読ませても締め方は決まらない。打ち切りは `lesson-loop.ts` の安全弁の仕事。 */
  it("残り時間が負でも0秒として出す", () => {
    expect(senpaiBoardRemainingNote(-30, "ja")).toBe("この授業の残り時間は 0 秒です。");
  });

  it("秒は整数に丸める", () => {
    expect(senpaiBoardRemainingNote(41.7, "ja")).toBe("この授業の残り時間は 41 秒です。");
  });
});
