import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planTurnSchema } from "./plan.ts";

/**
 * Checks that the examples in `prompts/study_plan.<locale>.md` match the shape the
 * contract currently accepts.
 *
 * Prompt examples are what an LLM imitates most strongly. Drift here makes the LLM
 * output "as shown", get rejected by the agent every time and regenerate (the
 * lesson stalls and only cost grows). And reading the prompt alone would not
 * reveal it - the example looks like valid JSON.
 *
 * This test lives in contract rather than `packages/prompts` because of dependency
 * direction. prompts has no dependencies, and reading the contract would mean
 * adding a workspace dependency. The other way round (contract reading
 * `prompts/*.md` as files) catches the same drift without changing the dependency
 * graph.
 */
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Looks only at the ```json fences that have the shape of one turn.
 * That way, adding a fragment without `speech` later (a partial example
 * illustrating one field) will not fail this test for no reason.
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
    // If the examples vanish entirely we want to know (do not let zero examples pass).
    expect(examples.length).toBeGreaterThan(0);

    for (const [index, example] of examples.entries()) {
      const parsed = planTurnSchema.safeParse(example);
      expect(parsed.success ? null : parsed.error.issues, `${locale} の見本 ${index}`).toBeNull();
    }
  });

  // Both an interview turn and a plan-producing turn must appear in the examples.
  // With only one, the LLM guesses the other shape without ever seeing it.
  it.each(["ja", "en"])("%s の見本に、聞き取り中と計画つきの両方がある", (locale) => {
    const plans = turnExamples(locale).map((example) => (example as { plan: unknown }).plan);
    expect(plans).toContain(null);
    expect(plans.some((plan) => plan !== null)).toBe(true);
  });
});
