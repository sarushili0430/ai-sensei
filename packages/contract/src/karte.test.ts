import { courseCodes, topicIdPattern, topics } from "@ai-sensei/curriculum";
import { describe, expect, it } from "vitest";
import { topicIdSchema } from "./karte.ts";

/**
 * 契約側は `@ai-sensei/curriculum` を実行時に持ち込まず、topic_idの正規表現を写している。
 * 写し忘れると、科目やコースを足した瞬間に**正しいIDがAPIの入口で落ちる**。
 * ここで両者を突き合わせておく。
 */
describe("topicIdSchema", () => {
  it("カリキュラムの全topic_idを通す", () => {
    for (const topic of topics) {
      expect(topicIdSchema.safeParse(topic.id).success, topic.id).toBe(true);
    }
  });

  it("カリキュラムのコース記号をすべて受け付ける", () => {
    for (const code of courseCodes) {
      const id = `${code}-FOO-BAR`;
      expect(topicIdPattern.test(id), id).toBe(true);
      expect(topicIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("形の壊れたIDを弾く", () => {
    for (const id of ["eg-jisei-shinko", "XX-FOO", "英文法-時制", ""]) {
      expect(topicIdSchema.safeParse(id).success, id).toBe(false);
      expect(topicIdPattern.test(id), id).toBe(false);
    }
  });
});
