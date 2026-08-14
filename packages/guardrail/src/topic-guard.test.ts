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
   * The default must match the number of levels the prompt promises the senpai.
   *
   * `prompts/senpai_board.{ja,en}.md` says the allow-list contains "two levels of
   * prerequisites". Shallower here and the second level never enters the allow-list,
   * so the prompt's description and the units actually handed over disagree.
   *
   * It checks the *default* rather than adding the option at the call site, because
   * the original bug was exactly the shape of "the caller forgot to write it".
   */
  it("既定で2段たどる(プロンプトの約束と同じ)", () => {
    expect(conversationPrerequisiteDepth).toBe(2);

    // Circle and line -> discriminant (level 1) -> quadratic function graph (level 2)
    const twoLevels = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"]);
    const oneLevel = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"], { prerequisiteDepth: 1 });
    expect(twoLevels.prerequisite.size).toBeGreaterThan(oneLevel.prerequisite.size);

    // A call that omits the option must give the same result as the default depth
    expect([...twoLevels.prerequisite].sort()).toEqual(
      [
        ...buildAllowedTopics(["M2-ZUKEI-ENCHOKU"], {
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
    // When empty, fall back to the default (the Japanese curriculum)
    expect(allowedTopicsLocale(buildAllowedTopics([]))).toBe("ja");
  });
});
