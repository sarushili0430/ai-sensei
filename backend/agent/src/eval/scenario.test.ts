import { isKnownTopicId } from "@ai-sensei/curriculum";
import { describe, expect, it } from "vitest";
import { sessionContextSchema, subjectOf } from "../context.ts";
import { boardSystemPrompt } from "./run-board.ts";
import {
  type EvalScenario,
  checkScenario,
  evalScenarios,
  findScenario,
  scenarioKey,
  selectScenarios,
} from "./scenario.ts";

/**
 * シナリオのテスト。**「本番では起きない入力を測っていないか」**を見る。
 *
 * 壊れていても板書は出てしまい、数字だけが静かに意味を失う種類の壊れ方
 * (実在しない topic_id・言語の食い違い・組めないプロンプト)を全部ここで止める。
 */

/** 各シナリオが**どの経路を撃つつもりか**。ここが期待値の正本。 */
const expectedSubject: Record<string, "math" | "english"> = {
  "math_quadratic.ja": "math",
  "math_quadratic.en": "math",
  "english_grammar.ja": "english",
  "english_relative.ja": "english",
  "math_review.ja": "math",
  "math_figure.ja": "math",
};

describe("evalScenarios", () => {
  it("組み込みは6本で、キーが重複しない", () => {
    const keys = evalScenarios.map((scenario) => scenarioKey(scenario));
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    expect(keys.sort()).toEqual(Object.keys(expectedSubject).sort());
  });

  it.each(evalScenarios.map((scenario) => [scenarioKey(scenario), scenario] as const))(
    "%s は契約・カリキュラム・プロンプトの3つを通る",
    (key, scenario: EvalScenario) => {
      // (a) contract の sessionMetadataSchema
      expect(sessionContextSchema.safeParse(scenario.context).success).toBe(true);

      // (b) 板書プロンプトが組める(教科 × 言語の版がある)
      expect(() => boardSystemPrompt(scenario)).not.toThrow();
      const system = boardSystemPrompt(scenario);
      expect(system).toContain(scenario.context.problem_text.split("\n")[0]);
      // 穴埋めの取り残しがあると `renderPrompt` が落ちるので、ここに来た時点で
      // 未展開のプレースホルダは無い。念のため形だけ見る。
      expect(system).not.toMatch(/\{\{/);

      // (c) allowed_topic_ids が実在する(書式だけ正しい別単元を弾く)
      expect(scenario.context.allowed_topic_ids.length).toBeGreaterThan(0);
      for (const id of scenario.context.allowed_topic_ids) {
        expect(isKnownTopicId(id), `${id} がカリキュラムにありません`).toBe(true);
      }

      // (d) 意図した教科に落ちる
      expect(subjectOf(scenario.context)).toBe(expectedSubject[key]);

      expect(checkScenario(scenario)).toEqual([]);
    },
  );

  it("復習シナリオは写真なしの経路(problem_text はプレースホルダ・review_hole がある)", () => {
    const review = findScenario("math_review", "ja");
    expect(review).toBeDefined();
    expect(review?.context.kind).toBe("review");
    expect(review?.context.review_hole?.topic_id).toBe("M1-NIJI-HANBETSU");
    // 文言の正本は `@ai-sensei/prompts` の formatProblemText。手で書かない。
    expect(review?.context.problem_text).toBe("(問題の写真なし)");
    // 復習は「ノートを撮っていない」ではなく「写真を使わない」ので (なし) 側。
    expect(review?.context.visible_work).toBe("(なし)");
  });

  it("英語のシナリオは ja だけ(senpai_board_english に en 版が無い)", () => {
    const english = evalScenarios.filter((scenario) => subjectOf(scenario.context) === "english");
    expect(english).toHaveLength(2);
    expect(english.every((scenario) => scenario.locale === "ja")).toBe(true);
    // 中学英語と高校英語で別の課程を踏むこと(接頭辞が違う)。
    expect(
      new Set(english.map((scenario) => scenario.context.allowed_topic_ids[0]?.slice(0, 2))),
    ).toEqual(new Set(["JE", "E1"]));
  });

  it("許可トピックには前提が入っている(主題だけにしない)", () => {
    const quadratic = findScenario("math_quadratic", "ja");
    expect(quadratic?.context.allowed_topic_ids[0]).toBe("J3-KAZUSHIKI-NIJI-HOTEISHIKI");
    expect(quadratic?.context.allowed_topic_ids.length).toBeGreaterThan(1);
    // 一覧の整形も許可IDと同じ集合から作る(片方だけ手書きだとずれる)。
    for (const id of quadratic?.context.allowed_topic_ids ?? []) {
      expect(quadratic?.context.allowed_topics).toContain(id);
    }
  });
});

describe("selectScenarios", () => {
  it("省略は全部・id と locale で絞れる", () => {
    expect(selectScenarios()).toHaveLength(evalScenarios.length);
    expect(selectScenarios({ scenario: "all", locale: "all" })).toHaveLength(evalScenarios.length);
    expect(selectScenarios({ locale: "en" }).map((s) => scenarioKey(s))).toEqual([
      "math_quadratic.en",
    ]);
    expect(selectScenarios({ scenario: "math_quadratic" }).map((s) => scenarioKey(s))).toEqual([
      "math_quadratic.ja",
      "math_quadratic.en",
    ]);
  });

  it("当てはまらなければ空(例外にしない)", () => {
    expect(selectScenarios({ scenario: "no_such_scenario" })).toEqual([]);
    expect(selectScenarios({ scenario: "english_grammar", locale: "en" })).toEqual([]);
  });
});

describe("checkScenario", () => {
  const base = evalScenarios[0] as EvalScenario;

  it("実在しない topic_id を見つける", () => {
    const broken: EvalScenario = {
      ...base,
      context: { ...base.context, allowed_topic_ids: ["M9-ARIENAI-TANGEN"] },
    };
    expect(checkScenario(broken).join(" ")).toContain("M9-ARIENAI-TANGEN");
  });

  it("会話の言語と課程の食い違いを見つける", () => {
    // 日本の課程のIDに locale: "en" を付けた(ADR 0005 — 言語は課程で決まる)。
    const broken: EvalScenario = {
      ...base,
      locale: "en",
      context: { ...base.context, locale: "en" },
    };
    expect(checkScenario(broken).join(" ")).toContain("指導言語");
  });

  it("review なのに review_hole が無いものを見つける", () => {
    const broken: EvalScenario = {
      ...base,
      context: { ...base.context, kind: "review", review_hole: null },
    };
    expect(checkScenario(broken).join(" ")).toContain("review_hole");
  });
});
