import {
  type CurriculumLocale,
  type SchoolStage,
  isKnownTopicId,
  isWellFormedTopicId,
  localeOfTopicId,
  stageOfTopicId,
} from "@ai-sensei/curriculum";
import { type AllowedTopics, buildAllowedTopics, isAllowedTopic } from "./topic-guard.ts";

/**
 * Unit matching for study plans (the second guard, plan edition).
 *
 * `plan.ts` in `@ai-sensei/contract` is a dependency-free layer and knows nothing
 * about prerequisites. So a plan whose interview recorded "the test covers
 * trigonometry" can contain a day of "two hours of vectors", pass the schema and
 * reach the screen. This closes that hole (the same stance `topic-guard.ts` takes
 * for the board and the karte).
 *
 * Scope and assignments are rejected differently on purpose.
 *
 *   - Scope ({@link checkPlanScope}) fails as a whole if even one entry is broken.
 *     The scope is the interviewed fact of "what is on the test", and silently
 *     dropping one unit produces a plan aimed at a narrower test than the real one.
 *     The student reaches the day without having studied part of the scope, with no
 *     way to notice.
 *   - Assignments ({@link filterPlanItems}) are dropped one at a time.
 *     These are generated output, so one out-of-scope day still leaves the rest
 *     usable. The same idea as `filterHoleTopicIds()` dropping karte holes one by one.
 */

/**
 * How far back a plan may reach for "the scope's prerequisites".
 *
 * Currently the same two levels as the conversation side
 * (`conversationPrerequisiteDepth` in `topic-guard.ts`). It is still a separate
 * constant because it is the same value from a different judgement: the
 * conversation side may want to go shallower for cost (session time), and having
 * plans silently follow would start rejecting legitimate review days as
 * out-of-scope.
 *
 * The original assumption was that plans should go deeper (a conversation's unit is
 * a question, a plan's is a day, and spending a day revising prerequisites is
 * ordinary tutoring). Measurement showed the depth is decided by the shape of the
 * curriculum, not by the unit of work:
 *
 *   | depth | topics added per topic (mean / max) |
 *   | --- | --- |
 *   | 1 | 0.98 / 4 (ja), 1.05 / 3 (en) |
 *   | 2 | 1.85 / 8 (ja), 2.07 / 7 (en) |
 *   | 3 | 2.37 / 11 (ja), 2.91 / 10 (en) |
 *
 * The longest prerequisite chain is only five levels, and it saturates at two
 * (level three and beyond add about 0.5 on average). So three levels does not buy
 * another day of revision; it just sprinkles in distant units.
 *
 * Meanwhile prerequisite edges extend along the learning order, so two levels never
 * reach another strand (vectors in a trigonometry plan) - the safe side of widening
 * has been measured.
 *
 * Deeper than this and the plan stops being test preparation and becomes redoing
 * the curriculum. A plan that cannot finish before the test is not kept, and an
 * unkept plan teaches only "plans are not for me" (the same reason as `contract`'s
 * `planDayMinutesMax`).
 */
export const planPrerequisiteDepth = 2;

export const planRejectionReasons = [
  /** The topic_id's shape is broken. */
  "malformed_topic_id",
  /** Well-formed but absent from the curriculum map (fabricated). */
  "unknown_topic_id",
  /** The scope mixes Japanese and overseas curricula. */
  "mixed_curricula",
  /** The scope came out empty (no matchable id at all). */
  "empty_scope",
  /** In the curriculum, but assigned a unit that is neither in scope nor a prerequisite. */
  "topic_out_of_scope",
] as const;
export type PlanRejectionReason = (typeof planRejectionReasons)[number];

export type PlanScopeVerdict =
  | { ok: true; allowed: AllowedTopics }
  | { ok: false; reason: PlanRejectionReason; detail: string };

export type BuildPlanTopicsOptions = {
  /** How many prerequisite levels to follow. Defaults to {@link planPrerequisiteDepth}. */
  prerequisiteDepth?: number;
};

/**
 * Checks the interviewed scope and, if it passes, returns the set of units a plan
 * may use.
 *
 * One failure fails the whole thing (reasoning at the top of the file). On
 * rejection the agent re-asks the scope or has it rebuilt with the allowed topics
 * attached. Never let a plan be built silently on a narrower scope.
 */
export function checkPlanScope(
  scopeTopicIds: readonly string[],
  options: BuildPlanTopicsOptions = {},
): PlanScopeVerdict {
  if (scopeTopicIds.length === 0) {
    return { ok: false, reason: "empty_scope", detail: "テスト範囲の単元が1つもありません" };
  }

  for (const topicId of scopeTopicIds) {
    if (!isWellFormedTopicId(topicId)) {
      return {
        ok: false,
        reason: "malformed_topic_id",
        detail: `topic_idの形式が不正: ${topicId}`,
      };
    }
    if (!isKnownTopicId(topicId)) {
      return {
        ok: false,
        reason: "unknown_topic_id",
        detail: `カリキュラムマップにないtopic_id: ${topicId}`,
      };
    }
  }

  /**
   * Mixed curricula. Checked only for plans.
   *
   * It looks at the language of instruction and the school stage, but not the subject:
   *
   *   - mixed language of instruction (Japanese + overseas curricula) ... the LLM
   *     drew on both curricula's memories, so the rest of the scope is untrustworthy
   *   - mixed school stage (middle + high school) ... Math II cannot be on a
   *     middle-schooler's term test; a mix is the same breakage as above
   *   - mixed subject (maths + English) ... allowed. Several subjects in one exam
   *     period is normal, and a middle-schooler's term test looks exactly like this
   *
   * This used to look only at the language of instruction. Japanese maths and
   * Japanese English are both `ja`, so it passed by coincidence - and relying on
   * coincidence lets mixed stages through. The predicate is written out explicitly.
   */
  const locales = new Set<CurriculumLocale>();
  const stages = new Set<SchoolStage>();
  for (const topicId of scopeTopicIds) {
    const locale = localeOfTopicId(topicId);
    if (locale) locales.add(locale);
    const stage = stageOfTopicId(topicId);
    if (stage) stages.add(stage);
  }
  if (locales.size > 1) {
    return {
      ok: false,
      reason: "mixed_curricula",
      detail: `1つの計画に複数の言語の課程が混ざっています: ${[...locales].join(", ")}`,
    };
  }
  if (stages.size > 1) {
    return {
      ok: false,
      reason: "mixed_curricula",
      detail: `1つの計画に中学と高校の単元が混ざっています: ${[...stages].join(", ")}`,
    };
  }

  const allowed = buildAllowedTopics(scopeTopicIds, {
    prerequisiteDepth: options.prerequisiteDepth ?? planPrerequisiteDepth,
  });
  // Shape and existence are already confirmed, so an empty set here means the caller is broken.
  if (allowed.primary.size === 0) {
    return { ok: false, reason: "empty_scope", detail: "テスト範囲の単元が1つもありません" };
  }

  return { ok: true, allowed };
}

export type PlanItemRejection<T> = {
  item: T;
  reason: PlanRejectionReason;
  detail: string;
};

export type PlanItemFilterResult<T> = {
  accepted: T[];
  rejected: PlanItemRejection<T>[];
};

/**
 * Checks each day's assignments one at a time.
 *
 * `allowed` is what {@link checkPlanScope} returned. Never call this alone,
 * skipping the scope check itself: if the scope is fabricated, the allow-set built
 * from its prerequisites stands on that fabrication and "in scope" means nothing.
 *
 * It is generic so `contract`'s `PlanItem` can be passed directly. guardrail does
 * not depend on contract, so it requires only that the value has a `topic_id`
 * (written the same way as `filterHoleTopicIds`).
 */
export function filterPlanItems<T extends { topic_id: string }>(
  items: readonly T[],
  allowed: AllowedTopics,
): PlanItemFilterResult<T> {
  const result: PlanItemFilterResult<T> = { accepted: [], rejected: [] };

  for (const item of items) {
    if (!isWellFormedTopicId(item.topic_id)) {
      result.rejected.push({
        item,
        reason: "malformed_topic_id",
        detail: `topic_idの形式が不正: ${item.topic_id}`,
      });
    } else if (!isKnownTopicId(item.topic_id)) {
      result.rejected.push({
        item,
        reason: "unknown_topic_id",
        detail: `カリキュラムマップにないtopic_id: ${item.topic_id}`,
      });
    } else if (!isAllowedTopic(allowed, item.topic_id)) {
      result.rejected.push({
        item,
        reason: "topic_out_of_scope",
        detail: `テスト範囲にもその前提にもない単元: ${item.topic_id}`,
      });
    } else {
      result.accepted.push(item);
    }
  }

  return result;
}

/**
 * The instruction attached to the regeneration prompt. Written in the
 * conversation's language (same reason as `topic-guard.ts` / `latex-guard.ts` -
 * mixing a Japanese instruction into an English conversation makes only the next
 * plan come back in Japanese).
 *
 * Every instruction points at either "ask again" or "rebuild within the scope".
 * Returning only "out of scope" makes the LLM rewrite the scope
 * (`intake.scope.topic_ids`) to make things add up - which falsifies the
 * interviewed facts, so the plan passes but describes a different test.
 */
export const planRejectionGuidanceByLocale: Record<
  CurriculumLocale,
  Record<PlanRejectionReason, string>
> = {
  ja: {
    malformed_topic_id:
      "topic_idは M2-SANKAKU-KAHO の形式で、許可リストからそのまま選ぶこと。作らないこと。",
    unknown_topic_id: "topic_idは渡された許可リストにあるものだけを使うこと。新しく作らないこと。",
    mixed_curricula:
      "1つの計画に複数の課程を混ぜないこと。生徒が言った範囲の課程だけで単元を選ぶこと。",
    empty_scope:
      "テスト範囲の単元が特定できていません。範囲を作らずに、生徒に「範囲は?」と聞き直すこと。",
    topic_out_of_scope:
      "テスト範囲(とその前提)の外の単元を計画に入れないこと。**範囲のほうを書き換えず**、その日の割り当てを範囲内の単元に差し替えること。",
  },
  en: {
    malformed_topic_id:
      "Use a topic_id in the PC-TRIG-IDENTITY form, copied exactly from the allowed list. Never invent one.",
    unknown_topic_id: "Only use topic_ids from the allowed list you were given. Do not invent one.",
    mixed_curricula:
      "Do not mix curricula in one plan. Pick topics from the one course sequence the student described.",
    empty_scope:
      "The topics on the test are not identified. Do not build a plan — ask the student what the test covers.",
    topic_out_of_scope:
      "Do not put topics outside the test range (or its prerequisites) into the plan. **Do not rewrite the range** — replace that day's work with a topic inside it.",
  },
};

/** The default (no locale given) is the Japanese wording. */
export const planRejectionGuidance: Record<PlanRejectionReason, string> =
  planRejectionGuidanceByLocale.ja;
