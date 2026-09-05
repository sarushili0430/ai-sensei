import { describe, expect, it } from "vitest";
import {
  allowedTopicsLocale,
  buildAllowedTopics,
  conversationPrerequisiteDepth,
  filterHoleTopicIds,
  isAllowedTopic,
} from "./topic-guard.ts";

const allowed = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"]);

describe("buildAllowedTopics", () => {
  it("検出した単元と、その前提を許可する", () => {
    expect(allowed.primary.has("M2-ZUKEI-ENCHOKU")).toBe(true);
    expect(allowed.prerequisite.has("M1-NIJI-HANBETSU")).toBe(true);
    expect(isAllowedTopic(allowed, "M2-ZUKEI-TENTO-KYORI")).toBe(true);
  });

  it("depth=0なら深掘りを許さない", () => {
    const shallow = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"], { prerequisiteDepth: 0 });
    expect(shallow.prerequisite.size).toBe(0);
    expect(isAllowedTopic(shallow, "M1-NIJI-HANBETSU")).toBe(false);
  });

  it("カリキュラムにないIDは黙って捨てる", () => {
    expect(buildAllowedTopics(["M2-SONZAI-SHINAI", "大学数学"]).primary.size).toBe(0);
  });

  /**
   * 呼び出し側で深さを書き足さなくても根まで届くことを固定する。
   * 元の不具合は、既定値が浅く、呼び出し側が書き忘れると戻れない形だった。
   */
  it("既定で前提チェーン全体をたどる", () => {
    expect(conversationPrerequisiteDepth).toBe(Number.POSITIVE_INFINITY);

    // 動名詞 → to不定詞 → 文構造 → 一般動詞 → be動詞。
    // 2段では文構造までで止まり、Issue #148 の生徒をbe動詞へ戻せない。
    const allLevels = buildAllowedTopics(["JE-DOMEISHI"]);
    const twoLevels = buildAllowedTopics(["JE-DOMEISHI"], { prerequisiteDepth: 2 });
    expect(twoLevels.prerequisite.has("JE-DOUSHI-BE")).toBe(false);
    expect(allLevels.prerequisite).toEqual(
      new Set(["JE-FUTEISHI", "JE-BUNKOZO-KIHON", "JE-DOUSHI-BE", "JE-DOUSHI-IPPAN"]),
    );

    // オプションを省いた呼び出しが、既定の深さと同じ結果になること。
    expect([...allLevels.prerequisite].sort()).toEqual(
      [
        ...buildAllowedTopics(["JE-DOMEISHI"], {
          prerequisiteDepth: conversationPrerequisiteDepth,
        }).prerequisite,
      ].sort(),
    );
  });
});

describe("filterHoleTopicIds", () => {
  it("許可範囲外のタグが付いた穴を落とす", () => {
    const result = filterHoleTopicIds(
      [
        { topic_id: "M1-NIJI-HANBETSU", desc: "判別式のなぜで止まった" },
        { topic_id: "M3-SEKIBUN-OYO", desc: "体積の求め方で止まった" },
      ],
      allowed,
    );
    expect(result.accepted.map((hole) => hole.topic_id)).toEqual(["M1-NIJI-HANBETSU"]);
    expect(result.rejected[0]?.reason).toBe("topic_not_allowed");
  });
});

describe("allowedTopicsLocale", () => {
  it("許可リストからロケールを決める", () => {
    expect(allowedTopicsLocale(buildAllowedTopics(["A2-COORD-CIRCLE"]))).toBe("en");
    expect(allowedTopicsLocale(buildAllowedTopics(["M2-ZUKEI-ENCHOKU"]))).toBe("ja");
    // 空のときは既定(日本の課程)に落とす
    expect(allowedTopicsLocale(buildAllowedTopics([]))).toBe("ja");
  });
});
