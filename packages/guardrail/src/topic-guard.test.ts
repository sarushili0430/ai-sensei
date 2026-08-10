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
   * **既定は、プロンプトが先輩に約束している段数と一致していなければならない。**
   *
   * `prompts/senpai_board.{ja,en}.md` は許可リストについて「前提が2段ぶん入っています」と
   * 説明している。ここが浅いと2段目の前提が許可リストに入らず、
   * プロンプトの説明と、先輩へ実際に渡す単元がずれる。
   *
   * 呼び出し側でオプションを書き足すのではなく**既定**を見ているのは、
   * 元の不具合が「呼び出し側が書き忘れた」形そのものだったから。
   */
  it("既定で2段たどる(プロンプトの約束と同じ)", () => {
    expect(conversationPrerequisiteDepth).toBe(2);

    // 円と直線 → 判別式(1段)→ 二次関数のグラフ(2段)
    const twoLevels = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"]);
    const oneLevel = buildAllowedTopics(["M2-ZUKEI-ENCHOKU"], { prerequisiteDepth: 1 });
    expect(twoLevels.prerequisite.size).toBeGreaterThan(oneLevel.prerequisite.size);

    // オプションを省いた呼び出しが、既定の段数と同じ結果になること
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
    // 空のときは既定(日本の課程)に落とす
    expect(allowedTopicsLocale(buildAllowedTopics([]))).toBe("ja");
  });
});
