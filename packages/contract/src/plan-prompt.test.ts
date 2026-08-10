import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planTurnSchema } from "./plan.ts";

/**
 * `prompts/study_plan.<locale>.md` の見本が、いま契約が受け付ける形かを確かめる。
 *
 * **プロンプトの見本は、LLMがいちばん強く真似る場所**です。ここが契約からずれると、
 * LLMは「見本どおりに」出力し、agent 側で毎回弾かれて再生成になる
 * (授業が止まり、原価だけが増える)。しかも**プロンプトを読んだだけでは気づけない** —
 * 見た目は正しいJSONだからです。
 *
 * このテストが `packages/prompts` ではなく contract にあるのは、**依存の向き**による。
 * prompts は依存を持たないパッケージで、契約を読むには workspace 依存を足すことになる。
 * 逆向き(contract から `prompts/*.md` を**ファイルとして読む**)なら、
 * 依存グラフを変えずに同じずれを捕まえられる。
 */
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/**
 * ```json フェンスのうち、**1ターンの形をしているものだけ**を見る。
 * `speech` を持たない断片(フィールドの説明のための一部だけの例)を将来足したときに、
 * このテストが理由なく落ちないようにするため。
 */
function turnExamples(locale: string): unknown[] {
  const source = readFileSync(resolve(repoRoot, `prompts/study_plan.${locale}.md`), "utf8");
  return [...source.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1] as string) as unknown)
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && "speech" in value,
    );
}

describe("計画プロンプトの見本", () => {
  it.each(["ja", "en"])("%s の見本が planTurnSchema を満たす", (locale) => {
    const examples = turnExamples(locale);
    // 見本が丸ごと消えたら、それはそれで検知したい(0件でも通ってしまう形にしない)。
    expect(examples.length).toBeGreaterThan(0);

    for (const [index, example] of examples.entries()) {
      const parsed = planTurnSchema.safeParse(example);
      expect(parsed.success ? null : parsed.error.issues, `${locale} の見本 ${index}`).toBeNull();
    }
  });

  // 聞き取り中のターンと、計画が出るターンの両方が見本にあること。
  // 片方しか無いと、LLMはもう片方の形を見ないまま推測することになる。
  it.each(["ja", "en"])("%s の見本に、聞き取り中と計画つきの両方がある", (locale) => {
    const plans = turnExamples(locale).map((example) => (example as { plan: unknown }).plan);
    expect(plans).toContain(null);
    expect(plans.some((plan) => plan !== null)).toBe(true);
  });
});
