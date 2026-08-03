import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allPrompts,
  conversationSystemPrompt,
  formatAllowedTopics,
  formatBullets,
  formatTranscript,
  getPrompt,
  karteSystemPrompt,
  parsePrompt,
  promptIds,
  PromptRenderError,
  renderPrompt,
} from "./index.ts";
import { buildGeneratedSource, promptFiles, promptsDir } from "./generate.ts";

describe("generated.ts", () => {
  // .mdを直して再生成を忘れると、実行時のプロンプトだけ古いまま残る
  it("prompts/*.md と一致している", () => {
    const committed = readFileSync(resolve(import.meta.dirname, "generated.ts"), "utf8");
    expect(committed, "npm run -w @ai-sensei/prompts generate を実行してください").toBe(
      buildGeneratedSource(),
    );
  });

  it("すべての.mdが取り込まれている", () => {
    expect(promptFiles().length).toBe(promptIds.length);
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
    const broken = parsePrompt(["---", "id: broken", "variables: [a]", "---", "{{a}} {{z}}"].join("\n"));
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
  });

  it("transcriptを役割つきで並べる", () => {
    expect(
      formatTranscript([
        { role: "assistant", text: "なんでですか?" },
        { role: "user", text: "距離で比べました" },
      ]),
    ).toBe("後輩: なんでですか?\nユーザー: 距離で比べました");
  });

  it("空リストはプレースホルダを返す", () => {
    expect(formatBullets([])).toBe("(なし)");
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
});

// プロンプトはコードのガードレールと二重に書く。片方だけ消える事故を防ぐ。
describe("設計上の約束がプロンプトに書かれている", () => {
  const bodies = allPrompts().map((template) => template.body);
  const all = bodies.join("\n");

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
