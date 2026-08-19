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
  // .mdを直して再生成を忘れると、実行時のプロンプトだけ古いまま残る
  it("prompts/*.md と一致している", () => {
    const committed = readFileSync(resolve(import.meta.dirname, "generated.ts"), "utf8");
    expect(committed, "pnpm --filter @ai-sensei/prompts generate を実行してください").toBe(
      buildGeneratedSource(),
    );
  });

  // ファイル数はカタログの宣言と突き合わせる。`id × ロケール` で数えると、
  // 教科別のプロンプト(英語の課程にしか無いもの)を足した瞬間に誤検知する。
  it("すべての.mdが取り込まれている(カタログの宣言と一致する)", () => {
    const declared = promptIds.reduce((sum, id) => sum + promptCatalog[id].length, 0);
    expect(promptFiles().length).toBe(declared);
  });
});

describe("ロケール", () => {
  // 片方の言語だけプロンプトを足すと、その言語のセッションが日本語に落ちる。
  it("カタログが宣言した (id × ロケール) がすべて揃っている", () => {
    for (const id of promptIds) {
      for (const locale of promptCatalog[id]) {
        const template = getPrompt(id, locale);
        expect(template.meta.id).toBe(id);
        expect(template.meta.locale, `${id} の ${locale}`).toBe(locale);
      }
    }
  });

  // 変数がずれていると、片方の言語だけ renderPrompt が落ちる(会話が始まらない)。
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
   * **カタログに無い組み合わせは、黙って日本語版に落とさず落とす。**
   *
   * ここでフォールバックすると、英語のセッションに日本語のプロンプトが渡って
   * 先輩が日本語を喋り出す。「無い」は設定漏れなので、起動時に気づきたい。
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
 * 音声補正ヒントは**教科で切り替える**。数学版の「さんぶんのに = 2/3」を
 * 英語の授業に当てると、生徒の発話を数式として読み直してしまう
 * (「言えているのに詰まった」と判定する原因になる)。
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
        problem_text: "Read the following passage and answer the question.",
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
    const karte = karteSystemPrompt(
      {
        problem_text: "円 x^2 + y^2 = 5 と直線の共有点を求めよ。",
        photo_summary: "円と直線",
        allowed_topics: "- M2-ZUKEI-ENCHOKU",
        transcript: "先輩: なんでですか?",
        is_premium: "false",
      },
      { subject: "math" },
    );
    expect(karte).toContain("said_well");
    expect(karte).toContain("円 x^2 + y^2 = 5");
    expect(karte).toContain("問題文を読み上げただけ");
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
        problem_text: "Find the intersections of the circle and line.",
        photo_summary: "A line-and-circle problem",
        allowed_topics: "- A2-COORD-CIRCLE",
        transcript: "Senpai: Why is that?",
        is_premium: "false",
      },
      { locale: "en", subject: "math" },
    );
    expect(karte).toContain("said_well");
    expect(karte).toContain("Find the intersections");
    expect(karte).toContain("Merely reading the question");
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

  it("問題文が入っているときは、冒頭で復唱も音読依頼もしないと明記する", () => {
    const ja = getPrompt("senpai_board", "ja").body;
    const en = getPrompt("senpai_board", "en").body;
    const englishLessonJa = getPrompt("senpai_board_english", "ja").body;

    expect(ja).toContain("冒頭で問題文を復唱せず");
    expect(ja).toContain("読み上げを頼まず");
    expect(en).toContain("do not repeat it or ask the student to read it aloud");
    expect(englishLessonJa).toContain("冒頭で問題文を復唱せず");
    expect(englishLessonJa).toContain("読み上げを頼まず");
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
   * transcriptには先輩の問いかけや相づちも入る。単に「transcriptから作る」では、
   * 先輩が教えた内容を本人の穴として1/3/7日後に繰り返すので、ロール名まで固定する。
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
   * **図形の授業が板書ごと落ちていた**(2026-08-12)。許可リストに ∠ も △ も ° も無く、
   * `\angle CAD = \angle ABC` は必ず弾かれる。落ちた手順は配送層がその回の説明ごと
   * 打ち切るので、**記号1つで授業が終わる**。
   *
   * 一覧の正は `packages/guardrail` の `allowedLatexCommands`(実測で足すもの)。
   * ここで見るのは、**プロンプト側の一覧がそこに追いついているか**だけ —
   * ずれると、描けるのにモデルが使わない(狭い)か、書いて弾かれる(広い)。
   */
  it("板書のLaTeX一覧に、図形と論証の記号が両方の言語で載っている", () => {
    const ja = getPrompt("senpai_board", "ja").body;
    const en = getPrompt("senpai_board", "en").body;

    for (const command of ["\\angle", "\\triangle", "\\sim", "\\perp", "^\\circ", "\\Rightarrow"]) {
      expect(ja, `senpai_board (ja) に ${command} が無い`).toContain(command);
      expect(en, `senpai_board (en) に ${command} が無い`).toContain(command);
    }

    // 実測で描けなかったものは「使えない」側に残っていること。
    expect(ja).toContain("\\overparen");
    expect(en).toContain("\\overparen");
  });

  /**
   * 外接円と接線。**語彙には無いが、既存のキーの組み合わせで書ける。**
   * 書き方を教えていなかったので、図形の問題で図が1枚も出ていなかった。
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
   * 1枚の写真に複数の問題が写る経路。**解析が全部並べると600字を超えて丸ごと捨てられ**、
   * 生徒には「問題が写っていない」と同じ結果になる(`resolveSessionProblem` の `too_long`)。
   * 収まった場合も、先輩はどれを教えるか分からないまま始める。
   */
  it("複数の問題が写ったときの決めが、解析と板書の両方に書かれている", () => {
    for (const locale of ["ja", "en"] as const) {
      const analysis = getPrompt("photo_analysis", locale).body;
      const board = getPrompt("senpai_board", locale).body;
      const marker = locale === "ja" ? "1つだけ" : "one";
      expect(analysis, `photo_analysis (${locale})`).toContain(marker);
      expect(board, `senpai_board (${locale})`).toContain(marker);
    }
    // 選び方が「最初の1問」まで書かれていること(理由だけだとモデルは並べ続ける)。
    expect(getPrompt("photo_analysis", "ja").body).toContain("いちばん最初の問題");
    expect(getPrompt("photo_analysis", "en").body).toContain("The first problem on the page");
    expect(getPrompt("photo_analysis", "ja").body).toContain(
      "ページ全体を書き起こしてはいけません",
    );
    expect(getPrompt("photo_analysis", "en").body).toContain("Never transcribe the whole page");
  });

  /**
   * 問題文が読めなかった授業の入口。「問題、読んでもらってもいい?」で**終える**。
   * ここで `steps` を続けると、読み上げを頼んだ直後に
   * 「じゃあ今の、説明してみて」が続き、教わっていない説明を求めることになる。
   */
  it("読み上げを頼んだらそこで終える、が両方の言語に書かれている", () => {
    expect(getPrompt("senpai_board", "ja").body).toContain("そこで `steps` を終えてください");
    expect(getPrompt("senpai_board", "en").body).toContain("End `steps` there");
  });

  /**
   * 授業は往復する(2026-08-14 のドッグフーディング報告への対応)。
   *
   * 「問いかけで `steps` を止めて答えを聞き、同じ板書に続きを積んで**教え切る**。
   * 教え返しへの受け渡しは『自分の言葉で説明してみて』の形だけ」— この形は
   * agent 側(`asksForTeachBack` / `runLessonLoop`)と二重書きで、プロンプト側だけ
   * 消えると、**質問を1つしただけで授業が終わる**古い形に静かに戻る。
   */
  it("授業の往復・答えまで書き切る解説が両方の言語に書かれている", () => {
    const ja = getPrompt("senpai_board", "ja").body;
    const en = getPrompt("senpai_board", "en").body;

    // 往復: 問いかけで止まり、続きは同じ板書に積まれる
    expect(ja).toContain("授業は往復する");
    expect(ja).toContain("同じ板書の下に");
    expect(en).toContain("The lesson goes back and forth");
    expect(en).toContain("under the same board");

    // 解説に重きを置く(2026-08-17): 答えの行まで板書で見せ切り、流れを一行に畳む。
    // 数値替えの確認問題を出して解かせる形はここで廃止した — たしかめは教え返しの仕事。
    expect(ja).toContain("答えまで、板書で見せ切る");
    expect(ja).toContain("答えの行まで");
    expect(ja).toContain("練習問題は出しません");
    expect(en).toContain("Write it through to the answer");
    expect(en).toContain("through to the answer line");
    expect(en).toContain("Never pose a numbers-changed practice problem");

    // 受け渡しの文言は往復を終える唯一の合図(`asksForTeachBack` と二重書き)。
    // 途中の問いかけに同じ言い方を許すと、授業の途中で教え返しへ切り替わる。
    expect(ja).toContain("自分の言葉で説明してみて");
    expect(ja).toContain("途中の問いかけには「説明して」を使わない");
    expect(en).toContain("in your own words");
    expect(en).toContain("for a mid-lesson checkpoint");

    // 教え返し側も、要約の最後の問いかけから会話を再開する(同じ質問を聞き直さない)
    expect(getPrompt("senpai_conversation", "ja").body).toContain("その答えを聞くところから");
    expect(getPrompt("senpai_conversation", "en").body).toContain("hearing their answer to it");
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
   * 復習は写真なしが正常。写真用プレースホルダを見た板書LLMが
   * 「問題を読んで」と戻らず、すでに自己申告した穴から教え始める指示を固定する。
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
