import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedSource, promptFiles, promptsDir } from "./generate.ts";
import {
  PromptRenderError,
  allPrompts,
  conversationSystemPrompt,
  formatAllowedTopics,
  formatBullets,
  formatTranscript,
  getPrompt,
  karteSystemPrompt,
  parsePrompt,
  promptIds,
  promptLocales,
  promptsFor,
  renderPrompt,
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
    expect(getPrompt("kohai_conversation", toPromptLocale("fr")).meta.locale).toBe("ja");
  });

  it("promptsFor はそのロケールの5本を返す", () => {
    expect(promptsFor("en").map((template) => template.meta.id)).toEqual([...promptIds]);
  });
});

describe("parsePrompt", () => {
  it("フロントマターと本文を分ける", () => {
    const template = getPrompt("kohai_conversation");
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
    ).toBe("後輩: なんでですか?\nユーザー: 距離で比べました");
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
    ).toBe("Kohai: Why is that?\nStudent: I compared the distance");
  });

  // 日本語の「(なし)」が英語のプロンプトに混ざると、そこだけ日本語で返ってくる。
  it("空リストはロケールに合ったプレースホルダを返す", () => {
    expect(formatBullets([])).toBe("(なし)");
    expect(formatBullets([], "en")).toBe("(none)");
  });
});

describe("組み立て済みプロンプト", () => {
  const conversation = conversationSystemPrompt({
    photo_summary: "円と直線の位置関係の問題",
    visible_work: "- 中心と直線の距離を求めている",
    allowed_topics: "- M2-ZUKEI-ENCHOKU",
    question_seeds: "- 方法を変えた理由",
    remaining_seconds: 300,
  });

  it("few-shotと音声補正ヒントを同梱する", () => {
    expect(conversation).toContain("え、なんで(2)でいきなり判別式を使ったんですか?");
    expect(conversation).toContain("さんぶんのに");
  });

  it("渡した文脈が埋まっている", () => {
    expect(conversation).toContain("円と直線の位置関係の問題");
    expect(conversation).toContain("300");
  });

  it("カルテ生成プロンプトも組み立てられる", () => {
    const karte = karteSystemPrompt({
      photo_summary: "円と直線",
      allowed_topics: "- M2-ZUKEI-ENCHOKU",
      transcript: "後輩: なんでですか?",
      is_premium: "false",
    });
    expect(karte).toContain("said_well");
    expect(karte).toContain("後輩: なんでですか?");
  });

  // 英語ロケールでは、日本語の本文に「英語で答えて」を足すのではなく、
  // 英語のプロンプトそのものを使う(ペルソナと禁止事項ごと差し替える)。
  const english = conversationSystemPrompt(
    {
      photo_summary: "A line-and-circle problem",
      visible_work: "- Finding the distance from the center to the line",
      allowed_topics: "- A2-COORD-CIRCLE",
      question_seeds: "- Why the method changed",
      remaining_seconds: 300,
    },
    "en",
  );

  it("英語の会話プロンプトに日本語が混ざらない", () => {
    expect(english).toContain("You are the user's **kohai**");
    expect(english).toContain("Wait, why did you go straight to the discriminant");
    expect(english).toContain("square root of 3");
    expect(english).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it("英語のカルテ生成プロンプトも組み立てられる", () => {
    const karte = karteSystemPrompt(
      {
        photo_summary: "A line-and-circle problem",
        allowed_topics: "- A2-COORD-CIRCLE",
        transcript: "Kohai: Why is that?",
        is_premium: "false",
      },
      "en",
    );
    expect(karte).toContain("said_well");
    expect(karte).toContain("Kohai: Why is that?");
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

  it("答えを教えない、が明記されている", () => {
    expect(all).toMatch(/答え(?:を教えない|・解説を書かない|・解き方・正解を言わない)/);
  });

  it("写真にない話題に触れない、が明記されている", () => {
    expect(all).toContain("写真に写っていない話題に触れない");
  });

  it("点数をつけない、が明記されている", () => {
    expect(all).toContain("点数をつけない");
  });

  it("パスを責めない、が明記されている", () => {
    expect(all).toContain("責めない");
  });

  // 4つの約束は言語ごとに書き直す。英語側だけ抜けると、
  // 海外のユーザーにだけ答えを教える後輩ができあがる。
  it("英語のプロンプトにも同じ4つの約束が書かれている", () => {
    expect(englishBodies).toMatch(/Never give the answer|Do not write solutions/);
    expect(englishBodies).toContain("Never bring up anything that is not in the photo");
    expect(englishBodies).toMatch(/Never grade/);
    expect(englishBodies).toMatch(/do not make them feel bad about it/);
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
