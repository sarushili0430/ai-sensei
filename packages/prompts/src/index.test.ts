import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedSource, promptFiles, promptsDir } from "./generate.ts";
import {
  PromptRenderError,
  allPrompts,
  boardLessonSystemPrompt,
  conversationSystemPrompt,
  formatAllowedTopics,
  formatBullets,
  formatProblemText,
  formatTranscript,
  formatVisibleWork,
  getPrompt,
  karteSystemPrompt,
  parsePrompt,
  promptCatalog,
  promptIds,
  promptLocales,
  promptsFor,
  renderPrompt,
  studyPlanSystemPrompt,
  toPromptLocale,
} from "./index.ts";

describe("generated.ts", () => {
  // Editing a .md and forgetting to regenerate leaves only the runtime prompt stale
  it("prompts/*.md と一致している", () => {
    const committed = readFileSync(resolve(import.meta.dirname, "generated.ts"), "utf8");
    expect(committed, "pnpm --filter @ai-sensei/prompts generate を実行してください").toBe(
      buildGeneratedSource(),
    );
  });

  // The file count is checked against the catalogue's declaration. Counting
  // `id x locale` would false-positive the moment a subject-specific prompt (one that
  // exists only for the English curricula) is added.
  it("すべての.mdが取り込まれている(カタログの宣言と一致する)", () => {
    const declared = promptIds.reduce((sum, id) => sum + promptCatalog[id].length, 0);
    expect(promptFiles().length).toBe(declared);
  });
});

describe("ロケール", () => {
  // Adding a prompt in only one language drops that language's sessions to Japanese.
  it("カタログが宣言した (id × ロケール) がすべて揃っている", () => {
    for (const id of promptIds) {
      for (const locale of promptCatalog[id]) {
        const template = getPrompt(id, locale);
        expect(template.meta.id).toBe(id);
        expect(template.meta.locale, `${id} の ${locale}`).toBe(locale);
      }
    }
  });

  // Drifted variables make `renderPrompt` fail in only one language (the conversation never starts).
  it("同じidなら、宣言している変数もロケール間で同じ", () => {
    for (const id of promptIds) {
      if (promptCatalog[id].length < 2) continue;
      const ja = [...getPrompt(id, "ja").meta.variables].sort();
      const en = [...getPrompt(id, "en").meta.variables].sort();
      expect(en, id).toEqual(ja);
    }
  });

  it("未対応の言語は日本語に落とす", () => {
    expect(toPromptLocale("fr")).toBe("ja");
    expect(getPrompt("senpai_conversation", toPromptLocale("fr")).meta.locale).toBe("ja");
  });

  /**
   * A combination absent from the catalogue throws rather than silently falling back
   * to Japanese.
   *
   * Falling back here would hand a Japanese prompt to an English session and have the
   * senpai start speaking Japanese. "Missing" means a configuration gap, and we want
   * to notice it at startup.
   */
  it("カタログに無い (id, ロケール) は例外にする", () => {
    expect(() => getPrompt("english_speech_hints", "en")).toThrow(/english_speech_hints/);
  });

  it("promptsFor はそのロケールで用意されているものだけを返す", () => {
    const en = promptsFor("en").map((template) => template.meta.id);
    expect(en).toEqual(promptIds.filter((id) => promptCatalog[id].includes("en")));
    expect(en).not.toContain("english_speech_hints");
    expect(promptsFor("ja").map((template) => template.meta.id)).toEqual([...promptIds]);
  });
});

/**
 * The speech-correction hints switch by subject. Applying the maths version's
 * "さんぶんのに = 2/3" to an English lesson re-reads the student's speech as formulas
 * (a cause of judging them stuck when they said it correctly).
 */
describe("教科ごとの音声補正ヒント", () => {
  const variables = {
    photo_summary: "現在完了の練習問題",
    visible_work: "- have + 過去分詞まで書けている",
    allowed_topics: "- JE-JISEI-KANRYO",
    question_seeds: "- なぜ過去形ではないのか",
    lesson_recap: "1. 「今とつながる過去、だったよね。」",
    remaining_seconds: 300,
  };

  it("英語の授業には英語のヒントが入り、数式のヒントは入らない", () => {
    const english = conversationSystemPrompt(variables, { subject: "english" });
    expect(english).toContain("冠詞");
    expect(english).not.toContain("さんぶんのに");
  });

  it("数学の授業には数式のヒントが入り、英語のヒントは入らない", () => {
    const math = conversationSystemPrompt(variables, { subject: "math" });
    expect(math).toContain("さんぶんのに");
    expect(math).not.toContain("冠詞");
  });

  it("カルテ生成でも教科で切り替わる", () => {
    const karte = karteSystemPrompt(
      {
        photo_summary: "現在完了の練習問題",
        allowed_topics: "- JE-JISEI-KANRYO",
        transcript: "先輩: なんでですか?",
        is_premium: "false",
      },
      { subject: "english" },
    );
    expect(karte).toContain("冠詞");
    expect(karte).not.toContain("さんぶんのに");
  });
});

describe("parsePrompt", () => {
  it("フロントマターと本文を分ける", () => {
    const template = getPrompt("senpai_conversation");
    expect(template.meta.model_role).toBe("conversation");
    expect(template.meta.variables).toContain("allowed_topics");
    expect(template.body.startsWith("---")).toBe(false);
  });

  it("フロントマターがなければエラー", () => {
    expect(() => parsePrompt("# ただの見出し")).toThrow();
  });
});

describe("renderPrompt", () => {
  const template = parsePrompt(
    ["---", "id: test", "variables: [a, b]", "---", "A={{a}} B={{ b }}"].join("\n"),
  );

  it("変数を埋める", () => {
    expect(renderPrompt(template, { a: "1", b: 2 })).toBe("A=1 B=2");
  });

  // An unfilled blank leads straight to running the LLM with an empty allow-list, so it fails
  it("変数が足りなければエラー", () => {
    expect(() => renderPrompt(template, { a: "1" })).toThrow(PromptRenderError);
  });

  it("宣言されていない変数を渡したらエラー", () => {
    expect(() => renderPrompt(template, { a: "1", b: "2", c: "3" })).toThrow(PromptRenderError);
  });

  it("未展開のプレースホルダが残ったらエラー", () => {
    const broken = parsePrompt(
      ["---", "id: broken", "variables: [a]", "---", "{{a}} {{z}}"].join("\n"),
    );
    expect(() => renderPrompt(broken, { a: "1" })).toThrow(/未展開/);
  });
});

describe("整形ヘルパ", () => {
  it("許可トピックを到達目標つきで並べる", () => {
    const text = formatAllowedTopics([
      {
        id: "M2-ZUKEI-ENCHOKU",
        course: "数学II",
        unit: "図形と方程式",
        topic: "円と直線の位置関係",
        goals: ["中心と直線の距離dと半径rの比較で位置関係を判定できる"],
      },
    ]);
    expect(text).toContain("M2-ZUKEI-ENCHOKU");
    expect(text).toContain("中心と直線の距離d");
  });

  it("許可トピックが空のときは撮り直しを促す文言になる", () => {
    expect(formatAllowedTopics([])).toContain("撮り直し");
    expect(formatAllowedTopics([], "en")).toContain("another photo");
  });

  it("transcriptを役割つきで並べる", () => {
    expect(
      formatTranscript([
        { role: "assistant", text: "なんでですか?" },
        { role: "user", text: "距離で比べました" },
      ]),
    ).toBe("先輩: なんでですか?\nユーザー: 距離で比べました");
  });

  it("英語のtranscriptは英語のロール名で並べる", () => {
    expect(
      formatTranscript(
        [
          { role: "assistant", text: "Why is that?" },
          { role: "user", text: "I compared the distance" },
        ],
        "en",
      ),
    ).toBe("Senpai: Why is that?\nStudent: I compared the distance");
  });

  // A Japanese "(none)" mixed into an English prompt makes that part answer in Japanese.
  it("空リストはロケールに合ったプレースホルダを返す", () => {
    expect(formatBullets([])).toBe("(なし)");
    expect(formatBullets([], "en")).toBe("(none)");
  });

  it("問題文は、読めなかったときだけプレースホルダに置き換える", () => {
    expect(formatProblemText("円 x^2 + y^2 = 5 と直線")).toBe("円 x^2 + y^2 = 5 と直線");
    expect(formatProblemText(null)).toBe("(問題の写真なし)");
    expect(formatProblemText(null, "en")).toBe("(no photo of the problem)");
  });

  /**
   * An empty string is not folded into `null`. Folding "unreadable" into `null` is
   * `backend/api`'s job, and catching it here to become a placeholder would let a
   * contract violation pass silently. Passed through, the agent's `.min(1)` surfaces it.
   */
  it("空文字はプレースホルダに化けさせない(契約違反を無音にしない)", () => {
    expect(formatProblemText("")).toBe("");
  });

  /**
   * The notes' three states. Using `formatBullets` directly collapses the bottom two
   * into the same "(none)", and the senpai then treats "a student who wrote nothing"
   * the same as "a student who took no notes photo".
   */
  it("ノートの3状態を区別して書き分ける", () => {
    expect(formatVisibleWork(["因数分解しかけている"])).toBe("- 因数分解しかけている");
    expect(formatVisibleWork([])).toBe("(なし)");
    expect(formatVisibleWork(null)).toBe("(ノートの写真なし)");

    expect(formatVisibleWork([], "en")).toBe("(none)");
    expect(formatVisibleWork(null, "en")).toBe("(no photo of their notes)");
  });
});

describe("組み立て済みプロンプト", () => {
  const conversation = conversationSystemPrompt(
    {
      photo_summary: "円と直線の位置関係の問題",
      visible_work: "- 中心と直線の距離を求めている",
      allowed_topics: "- M2-ZUKEI-ENCHOKU",
      question_seeds: "- 方法を変えた理由",
      lesson_recap: "1. 「この形だったよね。」 / 板書: D = b^2 - 4ac",
      remaining_seconds: 300,
    },
    { subject: "math" },
  );

  it("few-shotと音声補正ヒントを同梱する", () => {
    expect(conversation).toContain("なんで(2)でいきなり判別式にしたの?");
    expect(conversation).toContain("さんぶんのに");
  });

  it("渡した文脈が埋まっている", () => {
    expect(conversation).toContain("円と直線の位置関係の問題");
    expect(conversation).toContain("300");
  });

  /**
   * The board summary goes into instructions only (plan §2).
   * The karte and the quiz are built from the transcript, so mixing what was taught
   * into it breaks "questions come from what the user explained". Since it is passed
   * at all, the disclaimer "this is not what the user was able to explain" must always
   * come with it.
   */
  it("板書の要約には、ユーザーの説明ではないという断りが必ず付く", () => {
    expect(conversation).toContain("D = b^2 - 4ac");
    expect(conversation).toContain("ユーザーが説明できた内容ではありません");
  });

  it("カルテ生成プロンプトも組み立てられる", () => {
    const karte = karteSystemPrompt(
      {
        photo_summary: "円と直線",
        allowed_topics: "- M2-ZUKEI-ENCHOKU",
        transcript: "先輩: なんでですか?",
        is_premium: "false",
      },
      { subject: "math" },
    );
    expect(karte).toContain("said_well");
    expect(karte).toContain("先輩: なんでですか?");
  });

  // In the English locale the English prompt itself is used, rather than appending
  // "answer in English" to a Japanese body (persona and bans are swapped too).
  const english = conversationSystemPrompt(
    {
      photo_summary: "A line-and-circle problem",
      visible_work: "- Finding the distance from the center to the line",
      allowed_topics: "- A2-COORD-CIRCLE",
      question_seeds: "- Why the method changed",
      lesson_recap: '1. "This was the shape." / board: D = b^2 - 4ac',
      remaining_seconds: 300,
    },
    { locale: "en", subject: "math" },
  );

  it("英語の会話プロンプトに日本語が混ざらない", () => {
    expect(english).toContain("You are the user's **senpai**");
    expect(english).toContain("Why'd you go straight to the discriminant");
    expect(english).toContain("square root of 3");
    expect(english).toContain("It is not something the user has explained.");
    expect(english).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it("英語のカルテ生成プロンプトも組み立てられる", () => {
    const karte = karteSystemPrompt(
      {
        photo_summary: "A line-and-circle problem",
        allowed_topics: "- A2-COORD-CIRCLE",
        transcript: "Senpai: Why is that?",
        is_premium: "false",
      },
      { locale: "en", subject: "math" },
    );
    expect(karte).toContain("said_well");
    expect(karte).toContain("Senpai: Why is that?");
    expect(karte).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

// Prompts are written twice, alongside the code guardrails. This prevents one side vanishing.
describe("設計上の約束がプロンプトに書かれている", () => {
  const bodies = allPrompts().map((template) => template.body);
  const all = bodies.join("\n");
  const englishBodies = promptsFor("en")
    .map((template) => template.body)
    .join("\n");

  /**
   * Promise 1 has been revised (pivot plan v1 §0).
   *
   *   ~~never give the answer~~ -> teach it, then have them teach it back
   *
   * "Never give the answer" being gone from the conversation prompts is correct. But
   * `photo_analysis` alone keeps the pre-revision form and must not be loosened - the
   * analyser's output decides what gets taught, and an answer here fixes a misreading
   * downstream (the revision-scope table in `prompts/README.md`).
   */
  it("解析器だけは「解答を書かない」が生きている", () => {
    expect(getPrompt("photo_analysis", "ja").body).toContain("解答・解説を書かない");
    expect(getPrompt("photo_analysis", "en").body).toContain("Do not write solutions");
  });

  /**
   * Post-revision promise 1. Not ending at teaching is part of the same promise; with
   * only the first half left it becomes an app that gives answers (exactly the option
   * the pivot rejected).
   */
  it("教える → 教え返させる、が両方の会話プロンプトに書かれている", () => {
    expect(getPrompt("senpai_board", "ja").body).toContain("教えっぱなしで終わらせない");
    expect(getPrompt("senpai_conversation", "ja").body).toContain("先に答えを埋めない");
    expect(getPrompt("senpai_board", "en").body).toContain("never teach and leave it there");
    expect(getPrompt("senpai_conversation", "en").body).toContain(
      "do not fill in the answer first",
    );
  });

  it("写真にない話題に触れない、が明記されている", () => {
    expect(all).toContain("写真に写っていない話題に触れない");
  });

  /**
   * The no-notes path (§4-1). One character of drift between the placeholder and the
   * prompt fails the test.
   *
   * Without this, the senpai asks a student with no notes to show their notes. That
   * student photographed only the problem and is a legitimate user with nothing to
   * show. The wording has exactly one source, `formatVisibleWork()`, so the check
   * compares against its return value directly.
   */
  it("ノートが無いときのプレースホルダを、プロンプトが名指しで見ている", () => {
    for (const locale of promptLocales) {
      const noNotes = formatVisibleWork(null, locale);
      const noWork = formatBullets([], locale);

      for (const id of ["senpai_board", "senpai_conversation"] as const) {
        const body = getPrompt(id, locale).body;
        expect(body, `${id} (${locale}) が ${noNotes} を見ていない`).toContain(noNotes);
        expect(body, `${id} (${locale}) が ${noWork} を見ていない`).toContain(noWork);
      }
    }
  });

  /**
   * The placeholder for an unreadable problem. Drift here stops the instruction "do
   * not reconstruct the problem text by guessing" from firing, and the senpai starts
   * teaching a problem it invented - the student learns something entirely wrong.
   * The conversation prompt does not receive the problem text, so only the board side
   * is checked.
   */
  it("問題が読めなかったときのプレースホルダを、板書プロンプトが名指しで見ている", () => {
    for (const locale of promptLocales) {
      const noProblem = formatProblemText(null, locale);
      const body = getPrompt("senpai_board", locale).body;
      expect(body, `senpai_board (${locale}) が ${noProblem} を見ていない`).toContain(noProblem);
    }
  });

  // The idea of "when there are no notes, ask aloud how far they got" was explicitly
  // dropped. An oral grounding step is not diagnosis but a way of making them report.
  it("ノートが無いときに「ノート見せて」と言わない、が両方の言語に書かれている", () => {
    expect(getPrompt("senpai_board", "ja").body).toContain("「ノート見せて」");
    expect(getPrompt("senpai_board", "ja").body).toContain("口でノートを再現させようとしないこと");
    expect(getPrompt("senpai_conversation", "ja").body).toContain("「ノート見せて」とは聞かない");

    expect(getPrompt("senpai_board", "en").body).toContain('Never ask "show me your notes"');
    expect(getPrompt("senpai_board", "en").body).toContain("reconstruct the page out loud");
    expect(getPrompt("senpai_conversation", "en").body).toContain('Never ask "show me your notes"');
  });

  // Promise 2, including "do not grade" - the senpai is the one who knows, so it could
  // pronounce "right / wrong". The judge is the student (the same logic as §2's quiz).
  it("点数をつけない・採点しない、が明記されている", () => {
    expect(all).toContain("点数をつけない");
    expect(getPrompt("senpai_conversation", "ja").body).toContain("採点もしない");
    expect(getPrompt("senpai_conversation", "ja").body).toContain("宣告しない");
  });

  it("パスを責めない、が明記されている", () => {
    expect(all).toContain("責めない");
    expect(getPrompt("senpai_conversation", "ja").body).toContain("パスは恥ではありません");
  });

  /**
   * Promise 4 (post-revision, deck §0): "notifications and paywalls are written as the
   * senpai's judgement: no numbers, no orders, no nagging".
   *
   * This is a hole newly opened by casting the AI as a senpai. A kouhai cannot say
   * "go study", but a senpai can, so without the prompt as a brake it will say it.
   */
  it("煽らない・命令しない・数字を見せない、が会話プロンプトに書かれている", () => {
    const ja = getPrompt("senpai_conversation", "ja").body;
    const en = getPrompt("senpai_conversation", "en").body;

    expect(ja).toContain("命令も催促もしない");
    expect(ja).toContain("数字も見せません");
    expect(en).toContain("Never push, never nag");
    expect(en).toContain("never show them numbers");
  });

  // The four promises are rewritten per language. Missing on the English side means
  // they are broken only for overseas users.
  it("英語のプロンプトにも同じ4つの約束が書かれている", () => {
    expect(englishBodies).toMatch(/Never bring up anything that is not in the photo/);
    expect(englishBodies).toMatch(/Never grade/);
    expect(englishBodies).toMatch(/Never make them feel bad for not knowing/);
    expect(englishBodies).toContain("Passing is not something to be ashamed of.");
  });

  /**
   * "Always make what they said they did not understand a hole" is also written twice,
   * once per language.
   *
   * This promise came in on develop (in response to a report of "said I don't
   * understand repeatedly, got no holes" on a real device). Adding it only on the
   * Japanese side would keep returning "today you explained without stalling" in
   * English sessions alone.
   */
  it("「わからない」を必ず穴にする、が両方の言語に書かれている", () => {
    const ja = getPrompt("karte_generation", "ja").body;
    const en = getPrompt("karte_generation", "en").body;

    expect(ja).toContain("必ず `holes` に入れてください");
    expect(ja).toContain("間違ったカルテ");
    expect(en).toContain("put it in `holes`");
    expect(en).toContain("wrong karte");
  });

  /**
   * The transcript contains the senpai's questions and acknowledgements too. "Build it
   * from the transcript" alone would repeat what the senpai taught as the student's own
   * hole after 1/3/7 days, so even the role labels are pinned.
   */
  it("小テストの出題元を本人の発話だけに限定する、が両方の言語に書かれている", () => {
    const ja = getPrompt("karte_generation", "ja").body;
    const en = getPrompt("karte_generation", "en").body;

    expect(ja).toContain("出題元は `<transcript>` の `ユーザー:` の行だけです");
    expect(ja).toContain("`先輩:` の行から作らないでください");
    expect(en).toContain(
      "Use only the `Student:` lines inside `<transcript>` as the source of the question",
    );
    expect(en).toContain("Do not derive it from `Senpai:` lines");
  });

  /**
   * The board prompt's (senpai's) promises. They are written twice, alongside contract
   * and guardrail, so this detects one side disappearing.
   *
   * Only "split long formulas before the =" has no counterpart in code (plan §3-6b).
   * That one line is currently all that keeps the board from overflowing, so the test
   * holds it in place rather than letting it vanish unnoticed.
   */
  it("板書の出力規約が両方の言語に書かれている", () => {
    const ja = getPrompt("senpai_board", "ja").body;
    const en = getPrompt("senpai_board", "en").body;

    expect(ja).toContain("120字以内");
    expect(ja).toContain("`=` の前で切って");
    expect(ja).toContain("text` 要素として送ってください");
    expect(en).toContain("120 characters max");
    expect(en).toContain("cut before the `=`");
    expect(en).toContain("`text` board element");
  });

  /**
   * Geometry lessons were losing their whole board (2026-08-12). The allow-list had no
   * ∠, no △ and no °, so `\angle CAD = \angle ABC` was always rejected. The delivery
   * layer aborts that whole explanation on a failed step, so one symbol ended the lesson.
   *
   * The authoritative list is `allowedLatexCommands` in `packages/guardrail` (added by
   * measurement). This only checks that the prompt's list has caught up: drift makes
   * the model avoid what it could render (too narrow) or write what gets rejected (too wide).
   */
  it("板書のLaTeX一覧に、図形と論証の記号が両方の言語で載っている", () => {
    const ja = getPrompt("senpai_board", "ja").body;
    const en = getPrompt("senpai_board", "en").body;

    for (const command of ["\\angle", "\\triangle", "\\sim", "\\perp", "^\\circ", "\\Rightarrow"]) {
      expect(ja, `senpai_board (ja) に ${command} が無い`).toContain(command);
      expect(en, `senpai_board (en) に ${command} が無い`).toContain(command);
    }

    // What failed measurement must stay on the "unusable" side.
    expect(ja).toContain("\\overparen");
    expect(en).toContain("\\overparen");
  });

  /**
   * Circumscribed circles and tangents. Not in the vocabulary, but writable by
   * combining existing keys. Nobody had documented how, so geometry problems produced
   * no figures at all.
   */
  it("円と接線の書き方が両方の言語に載っている", () => {
    const ja = getPrompt("senpai_board", "ja").body;
    const en = getPrompt("senpai_board", "en").body;

    expect(ja).toContain("3点を通る円」は書けません");
    expect(ja).toContain('"perp": ["O", "A"]');
    expect(en).toContain("cannot be written");
    expect(en).toContain('"perp": ["O", "A"]');
  });

  /**
   * The path where one photo contains several problems. Listing them all pushes the
   * analysis past 600 characters and it is discarded whole, giving the student the same
   * result as "no problem in the photo" (`resolveSessionProblem`'s `too_long`). Even
   * when it fits, the senpai starts without knowing which one to teach.
   */
  it("複数の問題が写ったときの決めが、解析と板書の両方に書かれている", () => {
    for (const locale of ["ja", "en"] as const) {
      const analysis = getPrompt("photo_analysis", locale).body;
      const board = getPrompt("senpai_board", locale).body;
      const marker = locale === "ja" ? "1つだけ" : "one";
      expect(analysis, `photo_analysis (${locale})`).toContain(marker);
      expect(board, `senpai_board (${locale})`).toContain(marker);
    }
    // The choice is spelled out down to "the very first problem" (given only a reason, the model keeps listing).
    expect(getPrompt("photo_analysis", "ja").body).toContain("いちばん最初の問題");
    expect(getPrompt("photo_analysis", "en").body).toContain("The first problem on the page");
  });

  /**
   * The entrance for a lesson whose problem text was unreadable: end on "could you read
   * the problem out?". Continuing `steps` here appends "now explain that back to me"
   * right after asking them to read aloud, demanding an explanation of something not
   * yet taught.
   */
  it("読み上げを頼んだらそこで終える、が両方の言語に書かれている", () => {
    expect(getPrompt("senpai_board", "ja").body).toContain("そこで `steps` を終えてください");
    expect(getPrompt("senpai_board", "en").body).toContain("End `steps` there");
  });

  /**
   * "Make them do it, do not make them report it." This app's starting point
   * (inception deck §1: "feeling you understood and being able to explain are
   * different, and the student cannot tell them apart"), turned into a way of
   * teaching. Loosen it and the lesson starts from a point the student does not
   * actually understand.
   */
  it("「申告させず、やらせる」が両方の言語に書かれている", () => {
    const ja = getPrompt("senpai_board", "ja").body;
    const en = getPrompt("senpai_board", "en").body;

    expect(ja).toContain("申告させず、やらせる");
    expect(ja).toContain("最初の一手、言ってみて");
    expect(ja).toContain("「うん / いや」で返せない形");
    expect(en).toContain("never ask them to self-report");
    expect(en).toContain('"tell me the first step"');
    expect(en).toContain('cannot answer with "yes" or "no"');
  });

  it("先輩のプロンプトは音声ヒントを同梱し、英語版に日本語が混ざらない", () => {
    const variables = {
      lesson_mode: "new" as const,
      problem_text: "x^2 - 3x + 2 < 0 を解け",
      student_work: "- 左辺を因数分解しかけて止まっている",
      review_context: "null",
      allowed_topics: "- M1-NIJI-FUTOSHIKI",
      remaining_seconds: 600,
    };
    const ja = boardLessonSystemPrompt(variables, { locale: "ja", subject: "math" });
    expect(ja).toContain("x^2 - 3x + 2 < 0 を解け");
    expect(ja).toContain("さんぶんのに");

    const en = boardLessonSystemPrompt(
      {
        lesson_mode: "new",
        problem_text: "Solve x^2 - 3x + 2 < 0",
        student_work: "- Started factorising the left side and stopped",
        review_context: "null",
        allowed_topics: "- A2-INEQ-QUADRATIC",
        remaining_seconds: 600,
      },
      { locale: "en", subject: "math" },
    );
    expect(en).toContain("Solve x^2 - 3x + 2 < 0");
    expect(en).toContain("square root of 3");
    expect(en).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  /**
   * Reviews normally have no photo. This pins the instruction that a board LLM seeing
   * the photo placeholder does not fall back to "read me the problem" but teaches from
   * the already self-reported hole.
   */
  it("復習モードは穴を根拠に、聞き直さず板書で教え直す", () => {
    const ja = boardLessonSystemPrompt(
      {
        lesson_mode: "review",
        problem_text: "(問題の写真なし)",
        student_work: "(なし)",
        review_context: JSON.stringify({
          topic_id: "M1-NIJI-GURAFU",
          desc: "平方完成が頂点を表す理由で説明が止まった",
          evidence: "形をそろえるため、だと思う",
        }),
        allowed_topics: "- M1-NIJI-GURAFU — 数学I / 二次関数 / 二次関数のグラフと平方完成",
        remaining_seconds: 600,
      },
      { locale: "ja", subject: "math" },
    );

    expect(ja).toContain("平方完成が頂点を表す理由で説明が止まった");
    expect(ja).toContain("冒頭で同じことを聞き直さず");
    expect(ja).toContain("すぐ板書で教え直してください");
    expect(ja).toContain("教えっぱなしで終わらせない");

    const en = boardLessonSystemPrompt(
      {
        lesson_mode: "review",
        problem_text: "(no photo of the problem)",
        student_work: "(none)",
        review_context: JSON.stringify({
          topic_id: "A1-QUAD-GRAPH",
          desc: "The explanation stalled at why completing the square reveals the vertex",
          evidence: "I think it is just to make the terms match",
        }),
        allowed_topics: "- A1-QUAD-GRAPH — Algebra 1 / Quadratics / Parabolas",
        remaining_seconds: 600,
      },
      { locale: "en", subject: "math" },
    );

    expect(en).toContain("why completing the square reveals the vertex");
    expect(en).toContain("Do not test the same thing again");
    expect(en).toContain("start reteaching");
    expect(en).toContain("never teach and leave it there");
    expect(en).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  /**
   * The study-plan (plan mode) promises.
   *
   * The one to protect most is "do not make it a form", the option explicitly rejected
   * in pivot plan v1 §1 (maximum friction before any value is felt -> first-run
   * drop-off). Loosen it and the questions grow one at a time until it is a form by voice.
   */
  it("計画モードの約束が両方の言語に書かれている", () => {
    const ja = getPrompt("study_plan", "ja").body;
    const en = getPrompt("study_plan", "en").body;

    // Not a form (only three things are asked)
    expect(ja).toContain("これはフォームではありません");
    expect(ja).toContain("聞くのは次の3つだけです");
    expect(en).toContain("this is not a form");
    expect(en).toContain("There are exactly three things you ask.");

    // Promise 2. A plan is where "target score" and "completion rate" creep in most
    // naturally, and it is meant for §5's parent report, so a number placed here
    // reaches the parent verbatim.
    expect(ja).toContain("目標点・正答率・理解度・偏差値・達成率");
    expect(en).toContain("No target grade, no percentage correct");

    // Never assign material they do not have (contract closes this by making material an index)
    expect(ja).toContain("聞いていない本の番号は書けません");
    expect(en).toContain("a book you were never told about");

    // A rebuild does not re-ask the facts (re-asking is a form again)
    expect(ja).toContain("`intake` を前回のまま写します");
    expect(en).toContain("copy `intake` across unchanged");

    // The quote reaches the parent report verbatim (§5-2)
    expect(ja).toContain("でっち上げないでください");
    expect(en).toContain("Never make it up");
  });

  it("計画のプロンプトは、今日の日付を受け取って組み立てられる", () => {
    const ja = studyPlanSystemPrompt({
      today: "2026-08-24",
      allowed_topics: "- M2-SANKAKU-KAHO",
      known_facts: "(なし)",
      current_plan: "(なし)",
      remaining_seconds: 600,
    });
    // The LLM does not know today, so it can decide neither how many days away "10 September" is nor which year.
    expect(ja).toContain("2026-08-24");
    expect(ja).toContain("M2-SANKAKU-KAHO");

    // The speech-correction hints are deliberately not bundled. Those fix formula
    // readings, whereas a plan interview produces dates, page numbers and workbook
    // names - different things (the reasoning is in index.ts's studyPlanSystemPrompt).
    expect(ja).not.toContain("さんぶんのに");

    const en = studyPlanSystemPrompt(
      {
        today: "2026-08-24",
        allowed_topics: "- PC-TRIG-IDENTITY",
        known_facts: "(none)",
        current_plan: "(none)",
        remaining_seconds: 600,
      },
      "en",
    );
    expect(en).toContain("PC-TRIG-IDENTITY");
    expect(en).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it("全プロンプトにフロントマターのidがある", () => {
    for (const template of allPrompts()) {
      expect(template.meta.id.length, template.meta.id).toBeGreaterThan(0);
    }
  });

  it("prompts/ 直下の.mdはすべて読み込める", () => {
    for (const file of promptFiles()) {
      expect(() => parsePrompt(readFileSync(resolve(promptsDir, file), "utf8"))).not.toThrow();
    }
  });
});
