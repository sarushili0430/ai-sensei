import { describe, expect, it } from "vitest";
import {
  checkPlanScope,
  filterPlanItems,
  planPrerequisiteDepth,
  planRejectionGuidance,
  planRejectionGuidanceByLocale,
  planRejectionReasons,
} from "./plan-guard.ts";
import { buildAllowedTopics, isAllowedTopic } from "./topic-guard.ts";

/** A typical test scope: second-term midterm = Math II trigonometry. */
const trigScope = ["M2-SANKAKU-KAHO", "M2-SANKAKU-HOTEISHIKI"];

function allowedFor(scope: readonly string[] = trigScope) {
  const verdict = checkPlanScope(scope);
  if (!verdict.ok) throw new Error(`範囲が通りませんでした: ${verdict.detail}`);
  return verdict.allowed;
}

describe("checkPlanScope — 通すべきもの", () => {
  it("カリキュラム内の範囲を通し、前提つきの許可集合を返す", () => {
    const verdict = checkPlanScope(trigScope);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    expect(verdict.allowed.primary.has("M2-SANKAKU-KAHO")).toBe(true);
    // Trigonometry's prerequisite is trigonometric ratios (Math I). Scheduling a revision day is ordinary tutoring.
    expect(verdict.allowed.prerequisite.has("M1-KEIRYO-SANKAKUHI")).toBe(true);
  });

  it("海外の課程でも同じように通る", () => {
    const verdict = checkPlanScope(["PC-TRIG-IDENTITY", "PC-TRIG-EQUATION"]);
    expect(verdict.ok).toBe(true);
  });
});

describe("checkPlanScope — 弾くべきもの", () => {
  /**
   * One broken entry fails the whole scope.
   * Silently dropping one unit produces a plan aimed at a narrower test than the real
   * one, and the student reaches the day without studying part of the scope (with no
   * way to notice).
   */
  it("1つでもカリキュラムにないIDがあれば、範囲ごと落とす", () => {
    const verdict = checkPlanScope([...trigScope, "M2-SONZAI-SHINAI"]);
    expect(verdict).toMatchObject({ ok: false, reason: "unknown_topic_id" });
  });

  it("形の壊れたIDを弾く", () => {
    expect(checkPlanScope(["三角関数"])).toMatchObject({
      ok: false,
      reason: "malformed_topic_id",
    });
  });

  it("空の範囲を弾く(範囲を作らずに聞き直させる)", () => {
    expect(checkPlanScope([])).toMatchObject({ ok: false, reason: "empty_scope" });
  });

  /**
   * Mixed curricula are checked only for plans. A mix means the LLM drew on both
   * curricula's memories, so the rest of the scope is untrustworthy too.
   */
  it("日本の課程と海外の課程が混ざった範囲を弾く", () => {
    const verdict = checkPlanScope(["M2-SANKAKU-KAHO", "PC-TRIG-IDENTITY"]);
    expect(verdict).toMatchObject({ ok: false, reason: "mixed_curricula" });
  });
});

describe("filterPlanItems", () => {
  it("範囲の単元を通す", () => {
    const result = filterPlanItems(
      [{ topic_id: "M2-SANKAKU-KAHO" }, { topic_id: "M2-SANKAKU-HOTEISHIKI" }],
      allowedFor(),
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
  });

  // "A day to recall trigonometric ratios first." A plan's unit is a day, so a prerequisite revision day is legitimate.
  it("範囲の前提にあたる復習日を通す", () => {
    const result = filterPlanItems([{ topic_id: "M1-KEIRYO-SANKAKUHI" }], allowedFor());
    expect(result.rejected).toEqual([]);
  });

  // Exactly the hole this closes. contract knows nothing about prerequisites and lets it through.
  it("範囲外の単元を割り当てた日を落とす", () => {
    const result = filterPlanItems(
      [{ topic_id: "M2-SANKAKU-KAHO" }, { topic_id: "MB-SURETSU-TOSA-TOHI" }],
      allowedFor(),
    );
    expect(result.accepted).toEqual([{ topic_id: "M2-SANKAKU-KAHO" }]);
    expect(result.rejected).toMatchObject([{ reason: "topic_out_of_scope" }]);
  });

  /**
   * Assignments are dropped one at a time (handled differently from the scope).
   * They are generated output, so one out-of-scope day still leaves the rest usable.
   */
  it("落ちた日以外は残る", () => {
    const result = filterPlanItems(
      [
        { topic_id: "M2-SANKAKU-KAHO", what: "加法定理を導出する" },
        { topic_id: "大学数学", what: "テイラー展開" },
        { topic_id: "M2-SANKAKU-HOTEISHIKI", what: "三角方程式を解く" },
      ],
      allowedFor(),
    );
    expect(result.accepted.map((item) => item.what)).toEqual([
      "加法定理を導出する",
      "三角方程式を解く",
    ]);
    expect(result.rejected).toMatchObject([{ reason: "malformed_topic_id" }]);
  });

  it("捏造したIDを落とす", () => {
    const result = filterPlanItems([{ topic_id: "M2-SONZAI-SHINAI" }], allowedFor());
    expect(result.rejected).toMatchObject([{ reason: "unknown_topic_id" }]);
  });
});

/**
 * How far prerequisites may reach is a design decision. It stops at two levels
 * because widening further adds few topics (it saturates at two) and turns "test
 * preparation" into "redoing the curriculum".
 */
describe("前提をどこまで許すか", () => {
  /**
   * The same value as the conversation side, but it does not follow it.
   *
   * The original assumption was that plans should go deeper (their unit is a day, not
   * a question), but they became equal once the conversation side was fixed to the two
   * levels its prompt promises. The constants stay separate because the conversation
   * side may want to go shallower for cost (session time), and having plans silently
   * follow would start rejecting legitimate revision days as out-of-scope.
   */
  it("会話側の深さが変わっても、計画の深さは動かない", () => {
    const plan = allowedFor(["M2-SANKAKU-HOTEISHIKI"]);
    // Trigonometric equations -> addition formulae (level 1) -> trigonometric ratios (level 2). Valid as a revision day.
    expect(isAllowedTopic(plan, "M1-KEIRYO-SANKAKUHI")).toBe(true);

    // Making the conversation side shallower leaves the plan side at planPrerequisiteDepth.
    const shallowConversation = buildAllowedTopics(["M2-SANKAKU-HOTEISHIKI"], {
      prerequisiteDepth: 1,
    });
    expect(isAllowedTopic(shallowConversation, "M1-KEIRYO-SANKAKUHI")).toBe(false);
    expect(planPrerequisiteDepth).toBe(2);
  });

  /**
   * Prerequisite edges extend along a subject's strand, so widening to two levels never
   * reaches another strand. Break this and widening the depth immediately admits
   * "sequences in a trigonometry plan".
   */
  it("深さを広げても、別の系列の単元までは届かない", () => {
    const plan = allowedFor();
    for (const unrelated of ["MB-SURETSU-TOSA-TOHI", "M2-ZUKEI-ENCHOKU", "MC-VECTOR-NAISEKI"]) {
      expect(isAllowedTopic(plan, unrelated), unrelated).toBe(false);
    }
  });

  it("深さは呼び出し側で上書きできる", () => {
    const shallow = checkPlanScope(["M2-SANKAKU-HOTEISHIKI"], { prerequisiteDepth: 1 });
    expect(shallow.ok).toBe(true);
    if (!shallow.ok) return;
    expect(isAllowedTopic(shallow.allowed, "M1-KEIRYO-SANKAKUHI")).toBe(false);
  });
});

describe("再生成の指示", () => {
  it("すべての理由に、両方の言語の指示がある", () => {
    for (const locale of ["ja", "en"] as const) {
      for (const reason of planRejectionReasons) {
        expect(
          planRejectionGuidanceByLocale[locale][reason].length,
          `${locale}/${reason}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(planRejectionGuidance).toBe(planRejectionGuidanceByLocale.ja);
  });

  /**
   * Returning only "out of scope" makes the LLM rewrite the scope to make things add
   * up. That falsifies the interviewed facts, so the plan passes while describing a
   * different test. This pins that the destination ("replace that day's assignments")
   * is spelled out.
   */
  it("範囲外の指示が、範囲を書き換えない方向を向いている", () => {
    expect(planRejectionGuidanceByLocale.ja.topic_out_of_scope).toContain("範囲のほうを書き換えず");
    expect(planRejectionGuidanceByLocale.en.topic_out_of_scope).toContain(
      "Do not rewrite the range",
    );
  });

  it("英語の指示に日本語が混ざらない", () => {
    for (const reason of planRejectionReasons) {
      expect(planRejectionGuidanceByLocale.en[reason], reason).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    }
  });
});

/**
 * A middle-schooler's term test lines up maths and English. Rejecting mixed subjects
 * would make the most common shape of plan impossible.
 */
describe("課程の混在(教科は通す・言語と段は落とす)", () => {
  it("数学と英語が混ざった範囲は通す", () => {
    const verdict = checkPlanScope(["J2-KANSU-ICHIJI", "JE-FUTEISHI"]);
    expect(verdict.ok).toBe(true);
  });

  it("中学と高校が混ざった範囲は落とす", () => {
    const verdict = checkPlanScope(["J3-KAZUSHIKI-NIJI-HOTEISHIKI", "M1-NIJI-HANBETSU"]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("mixed_curricula");
  });

  it("日本の課程と海外の課程が混ざった範囲は落とす", () => {
    const verdict = checkPlanScope(["M1-NIJI-HANBETSU", "A1-QUAD-SOLVE"]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("mixed_curricula");
  });
});
