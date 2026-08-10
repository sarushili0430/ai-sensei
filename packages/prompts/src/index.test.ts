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
  promptIds,
  promptLocales,
  promptsFor,
  renderPrompt,
  studyPlanSystemPrompt,
  toPromptLocale,
} from "./index.ts";

describe("generated.ts", () => {
  // .mdを直して再生成を忘れると、実行時のプロンプトだけ古いまま残る
  it("prompts/*.md と一致している", () => {
    const committed = readFileSync(resolve(import.meta.dirname, "generated.ts"), "utf8");
    expect(committed, "pnpm --filter @ai-sensei/prompts generate を実行してください").toBe(
      buildGeneratedSource(),
    );
  });

  it("すべての.mdが取り込まれている(id × ロケール)", () => {
    expect(promptFiles().length).toBe(promptIds.length * promptLocales.length);
  });
});

describe("ロケール", () => {
  // 片方の言語だけプロンプトを足すと、その言語のセッションが日本語に落ちる。
  it("すべてのidが、すべてのロケールで揃っている", () => {
    for (const locale of promptLocales) {
      for (const id of promptIds) {
        const template = getPrompt(id, locale);
        expect(template.meta.id).toBe(id);
        expect(template.meta.locale, `${id} の ${locale}`).toBe(locale);
      }
    }
  });

  // 変数がずれていると、片方の言語だけ renderPrompt が落ちる(会話が始まらない)。
  it("同じidなら、宣言している変数もロケール間で同じ", () => {
    for (const id of promptIds) {
      const ja = [...getPrompt(id, "ja").meta.variables].sort();
      const en = [...getPrompt(id, "en").meta.variables].sort();
      expect(en, id).toEqual(ja);
    }
  });

  it("未対応の言語は日本語に落とす", () => {
    expect(toPromptLocale("fr")).toBe("ja");
    expect(getPrompt("senpai_conversation", toPromptLocale("fr")).meta.locale).toBe("ja");
  });

  it("promptsFor はそのロケールの全部を返す", () => {
    expect(promptsFor("en").map((template) => template.meta.id)).toEqual([...promptIds]);
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

  // 穴埋め漏れは「許可リストが空のままLLMを走らせる」に直結するので落とす
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

  // 日本語の「(なし)」が英語のプロンプトに混ざると、そこだけ日本語で返ってくる。
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
   * **空文字を `null` に畳まない。**「読めなかった」を `null` に寄せるのは
   * `backend/api` の責務で、ここで拾ってプレースホルダに化けさせると
   * **契約違反が無音で通る**。素通しすれば agent の `.min(1)` で表面化する。
   */
  it("空文字はプレースホルダに化けさせない(契約違反を無音にしない)", () => {
    expect(formatProblemText("")).toBe("");
  });

  /**
   * ノートの3状態。`formatBullets` を直に使うと下2つが同じ「(なし)」になり、
   * 先輩は**「ノートに何も書いていない生徒」と「ノートを撮らなかった生徒」を同じに扱う**。
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
  const conversation = conversationSystemPrompt({
    photo_summary: "円と直線の位置関係の問題",
    visible_work: "- 中心と直線の距離を求めている",
    allowed_topics: "- M2-ZUKEI-ENCHOKU",
    question_seeds: "- 方法を変えた理由",
    lesson_recap: "1. 「この形だったよね。」 / 板書: D = b^2 - 4ac",
    remaining_seconds: 300,
  });

  it("few-shotと音声補正ヒントを同梱する", () => {
    expect(conversation).toContain("なんで(2)でいきなり判別式にしたの?");
    expect(conversation).toContain("さんぶんのに");
  });

  it("渡した文脈が埋まっている", () => {
    expect(conversation).toContain("円と直線の位置関係の問題");
    expect(conversation).toContain("300");
  });

  /**
   * 板書の要約は **instructions にだけ**入れる(計画書 §2)。
   * カルテと小テストの材料は transcript なので、そこに教えた内容が混ざると
   * 「出題元はユーザーが説明した内容」が壊れる。渡した以上、
   * **「これはユーザーが説明できた内容ではない」の断り書きが必ず一緒に出る**こと。
   */
  it("板書の要約には、ユーザーの説明ではないという断りが必ず付く", () => {
    expect(conversation).toContain("D = b^2 - 4ac");
    expect(conversation).toContain("ユーザーが説明できた内容ではありません");
  });

  it("カルテ生成プロンプトも組み立てられる", () => {
    const karte = karteSystemPrompt({
      photo_summary: "円と直線",
      allowed_topics: "- M2-ZUKEI-ENCHOKU",
      transcript: "先輩: なんでですか?",
      is_premium: "false",
    });
    expect(karte).toContain("said_well");
    expect(karte).toContain("先輩: なんでですか?");
  });

  // 英語ロケールでは、日本語の本文に「英語で答えて」を足すのではなく、
  // 英語のプロンプトそのものを使う(ペルソナと禁止事項ごと差し替える)。
  const english = conversationSystemPrompt(
    {
      photo_summary: "A line-and-circle problem",
      visible_work: "- Finding the distance from the center to the line",
      allowed_topics: "- A2-COORD-CIRCLE",
      question_seeds: "- Why the method changed",
      lesson_recap: '1. "This was the shape." / board: D = b^2 - 4ac',
      remaining_seconds: 300,
    },
    "en",
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
      "en",
    );
    expect(karte).toContain("said_well");
    expect(karte).toContain("Senpai: Why is that?");
    expect(karte).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

// プロンプトはコードのガードレールと二重に書く。片方だけ消える事故を防ぐ。
describe("設計上の約束がプロンプトに書かれている", () => {
  const bodies = allPrompts().map((template) => template.body);
  const all = bodies.join("\n");
  const englishBodies = promptsFor("en")
    .map((template) => template.body)
    .join("\n");

  /**
   * 約束1は**改正されている**(ピボット計画 v1 §0)。
   *
   *   ~~答えを教えない~~ → **教える。そのあと教え返させる**
   *
   * 会話プロンプトから「答えを教えない」が消えているのは正しい。ただし
   * `photo_analysis` だけは**改正前のまま**で、そこは緩めない —
   * 解析器の出力は「何を教えるか」を決めるための材料で、ここに解答が入ると
   * **誤読が下流に固定される**(`prompts/README.md` の改正範囲の表)。
   */
  it("解析器だけは「解答を書かない」が生きている", () => {
    expect(getPrompt("photo_analysis", "ja").body).toContain("解答・解説を書かない");
    expect(getPrompt("photo_analysis", "en").body).toContain("Do not write solutions");
  });

  /**
   * 改正後の約束1。**教えっぱなしで終わらせない**ところまでが1つの約束で、
   * 前半だけ残ると「答えを教えるアプリ」になる(ピボットで却下された案そのもの)。
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
   * **ノートが無い経路(§4-1)。プレースホルダの文言が、プロンプトと1文字でもずれたら落とす。**
   *
   * ここが効かないと、先輩は**ノートを持っていない生徒に「ノート見せて」と言い出す**。
   * その生徒は問題だけを撮ってきた正規の利用者で、出せるものが無い。
   * 文言の出どころは `formatVisibleWork()` ただ1つなので、**その戻り値そのもの**で照合する。
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
   * **問題が読めなかったときのプレースホルダ。**ここがずれると
   * 「問題文を推測で組み立てないこと」の指示が発火しないまま、
   * **先輩が自分で作った問題を教えはじめる** — 生徒はまるごと間違ったことを覚える。
   * 会話プロンプトは問題文を受け取らないので、見るのは板書側だけ。
   */
  it("問題が読めなかったときのプレースホルダを、板書プロンプトが名指しで見ている", () => {
    for (const locale of promptLocales) {
      const noProblem = formatProblemText(null, locale);
      const body = getPrompt("senpai_board", locale).body;
      expect(body, `senpai_board (${locale}) が ${noProblem} を見ていない`).toContain(noProblem);
    }
  });

  // 「ノートが無いときは口頭で『どこまでやってみた?』と聞く」案は明示的に見送られた。
  // 口頭のグラウンディング手順を足すと、それは切り分けではなく申告させる聞き方になる。
  it("ノートが無いときに「ノート見せて」と言わない、が両方の言語に書かれている", () => {
    expect(getPrompt("senpai_board", "ja").body).toContain("「ノート見せて」");
    expect(getPrompt("senpai_board", "ja").body).toContain("口でノートを再現させようとしないこと");
    expect(getPrompt("senpai_conversation", "ja").body).toContain("「ノート見せて」とは聞かない");

    expect(getPrompt("senpai_board", "en").body).toContain('Never ask "show me your notes"');
    expect(getPrompt("senpai_board", "en").body).toContain("reconstruct the page out loud");
    expect(getPrompt("senpai_conversation", "en").body).toContain('Never ask "show me your notes"');
  });

  // 約束2。**「採点しない」まで含める** — 先輩は分かっている側なので、
  // 「合ってる / 違う」を宣告できてしまう。判定者は本人(§2 の小テストと同じ理屈)。
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
   * 約束4(改正後・デッキ §0)。「通知もペイウォールも、先輩の判断として書く。
   * **数字は見せず、命令や催促にもしない**」。
   *
   * ここは配役を先輩に変えたことで**新しく開いた穴**。後輩は「勉強しろ」と言えないが、
   * 先輩は言える立場なので、プロンプトが歯止めになっていないと素で言う。
   */
  it("煽らない・命令しない・数字を見せない、が会話プロンプトに書かれている", () => {
    const ja = getPrompt("senpai_conversation", "ja").body;
    const en = getPrompt("senpai_conversation", "en").body;

    expect(ja).toContain("命令も催促もしない");
    expect(ja).toContain("数字も見せません");
    expect(en).toContain("Never push, never nag");
    expect(en).toContain("never show them numbers");
  });

  // 4つの約束は言語ごとに書き直す。英語側だけ抜けると、
  // 海外のユーザーにだけ約束が破られる。
  it("英語のプロンプトにも同じ4つの約束が書かれている", () => {
    expect(englishBodies).toMatch(/Never bring up anything that is not in the photo/);
    expect(englishBodies).toMatch(/Never grade/);
    expect(englishBodies).toMatch(/Never make them feel bad for not knowing/);
    expect(englishBodies).toContain("Passing is not something to be ashamed of.");
  });

  /**
   * 「わからない」と言われた箇所は必ず穴にする、も言語ごとに二重で書く。
   *
   * これは develop で入った約束(実機で「わからないと何度も言ったのに穴なし」に
   * なった報告への対応)。日本語側にだけ足すと、英語のセッションでだけ
   * 「今日は、止まらずに説明できました」が返り続ける。
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
   * 板書プロンプト(先輩)の約束。**contract / guardrail と二重に書いている**ので、
   * 片方が消えたことを検知できるようにここで見る。
   *
   * 「長い式は = の前で割る」だけはコード側に相手がいない(計画書 §3-6b)。
   * 板書がはみ出さないことを守っているのは、いまのところこの1行だけなので、
   * 消えても誰も気づかない状態にしないためにテストで留める。
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
   * 【申告させず、やらせる】。このアプリの出発点(インセプションデッキ §1
   * 「わかったと感じた状態と説明できる状態は別物で、前者は本人には区別がつかない」)を
   * 教え方に落としたもので、**ここが緩むと、本人が分かっていない地点から授業が始まる**。
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
      problem_text: "x^2 - 3x + 2 < 0 を解け",
      student_work: "- 左辺を因数分解しかけて止まっている",
      allowed_topics: "- M1-NIJI-FUTOSHIKI",
      remaining_seconds: 600,
    };
    const ja = boardLessonSystemPrompt(variables, "ja");
    expect(ja).toContain("x^2 - 3x + 2 < 0 を解け");
    expect(ja).toContain("さんぶんのに");

    const en = boardLessonSystemPrompt(
      {
        problem_text: "Solve x^2 - 3x + 2 < 0",
        student_work: "- Started factorising the left side and stopped",
        allowed_topics: "- A2-INEQ-QUADRATIC",
        remaining_seconds: 600,
      },
      "en",
    );
    expect(en).toContain("Solve x^2 - 3x + 2 < 0");
    expect(en).toContain("square root of 3");
    expect(en).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  /**
   * 学習計画(計画モード)の約束。
   *
   * **いちばん守りたいのは「フォームにしない」**で、これは
   * ピボット計画 v1 §1 で明示的に却下された案(価値を体験する前の摩擦が最大 → 初回離脱)。
   * ここが緩むと、質問が1つずつ増えていって、気づいたときには音声のフォームになっている。
   */
  it("計画モードの約束が両方の言語に書かれている", () => {
    const ja = getPrompt("study_plan", "ja").body;
    const en = getPrompt("study_plan", "en").body;

    // フォームにしない(聞くのは3つだけ)
    expect(ja).toContain("これはフォームではありません");
    expect(ja).toContain("聞くのは次の3つだけです");
    expect(en).toContain("this is not a form");
    expect(en).toContain("There are exactly three things you ask.");

    // 約束2。計画は「目標点」「達成率」がいちばん自然に入り込む場所で、
    // しかも §5 の親レポートに載る前提なので、置いた数字はそのまま親に届く。
    expect(ja).toContain("目標点・正答率・理解度・偏差値・達成率");
    expect(en).toContain("No target grade, no percentage correct");

    // 持っていない教材を割り当てない(contract 側は material を添字にして塞いでいる)
    expect(ja).toContain("聞いていない本の番号は書けません");
    expect(en).toContain("a book you were never told about");

    // 組み直しで事実を聞き直さない(聞き直すとフォームに戻る)
    expect(ja).toContain("`intake` を前回のまま写します");
    expect(en).toContain("copy `intake` across unchanged");

    // 引用は親レポートにそのまま載る(§5-2)
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
    // LLMは今日を知らないので、「9月10日」が何日後かも今年かも決められない。
    expect(ja).toContain("2026-08-24");
    expect(ja).toContain("M2-SANKAKU-KAHO");

    // **音声補正ヒントは意図的に同梱していない。** あれは数式の読み上げを直すためのもので、
    // 計画の聞き取りに出るのは日付・ページ番号・問題集の名前という別物
    // (index.ts の studyPlanSystemPrompt に理由がある)。
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
