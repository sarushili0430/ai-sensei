import { describe, expect, it } from "vitest";
import {
  checkIntegrity,
  curriculum,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  prerequisitesOf,
  suggestTopics,
  topics,
  topicsByCourse,
} from "./index.ts";
import { courseNames } from "./schema.ts";

describe("カリキュラムデータの整合性", () => {
  it("スキーマを満たす(importの時点でparse済み)", () => {
    expect(curriculum.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(topics.length).toBeGreaterThanOrEqual(30);
  });

  it("ID重複・未定義の前提・循環がない", () => {
    expect(checkIntegrity()).toEqual([]);
  });

  it("6科目すべてにトピックがある", () => {
    for (const course of courseNames) {
      expect(topicsByCourse(course).length, `${course} のトピックが空`).toBeGreaterThan(0);
    }
  });

  it("すべてのトピックに到達目標とキーワードがある", () => {
    for (const topic of topics) {
      expect(topic.goals.length, topic.id).toBeGreaterThan(0);
      expect(topic.keywords.length, topic.id).toBeGreaterThan(0);
    }
  });

  // 技能目標(「因数分解できる」)だけのトピックがあると、そこから作れる質問が
  // 「解けますか?」になってしまう。各トピックに説明を問える目標を最低1つ持たせる。
  it("すべてのトピックに、説明を問える到達目標が最低1つある", () => {
    const explainable = /説明できる|使い分け|導ける|判断/;
    for (const topic of topics) {
      expect(
        topic.goals.some((goal) => explainable.test(goal)),
        topic.id,
      ).toBe(true);
    }
  });
});

// 新課程(2022年度〜)の要注意点。旧課程の知識で書き足すと必ずここで落ちる。
describe("新課程の配当", () => {
  it("ベクトルは数学B ではなく 数学C にある", () => {
    const vectorTopics = topics.filter((topic) => topic.unit === "ベクトル");
    expect(vectorTopics.length).toBeGreaterThan(0);
    for (const topic of vectorTopics) {
      expect(topic.course, topic.id).toBe("数学C");
    }
  });

  it("統計的な推測は数学Bにある", () => {
    const statistics = topics.filter((topic) => topic.unit === "統計的な推測");
    expect(statistics.length).toBeGreaterThan(0);
    for (const topic of statistics) {
      expect(topic.course, topic.id).toBe("数学B");
    }
  });

  it("仮説検定の考え方は数学Iのデータの分析にある", () => {
    const topic = findTopic("M1-DATA-KASETSU-KENTEI");
    expect(topic?.course).toBe("数学I");
    expect(topic?.unit).toBe("データの分析");
  });
});

describe("topic_idの判定", () => {
  it("既知のIDを通す", () => {
    expect(isKnownTopicId("M2-ZUKEI-ENCHOKU")).toBe(true);
  });

  it("形は正しいが未定義のIDを弾く", () => {
    expect(isWellFormedTopicId("M2-SONZAI-SHINAI")).toBe(true);
    expect(isKnownTopicId("M2-SONZAI-SHINAI")).toBe(false);
  });

  it("形の壊れたIDを弾く", () => {
    expect(isWellFormedTopicId("大学数学-線形代数")).toBe(false);
    expect(isWellFormedTopicId("m2-zukei-enchoku")).toBe(false);
    expect(isWellFormedTopicId("")).toBe(false);
  });
});

describe("prerequisitesOf", () => {
  it("直接の前提を返す", () => {
    const ids = prerequisitesOf("M2-ZUKEI-ENCHOKU").map((topic) => topic.id);
    expect(ids).toContain("M1-NIJI-HANBETSU");
    expect(ids).toContain("M2-ZUKEI-TENTO-KYORI");
  });

  it("微分の深掘りで、微分する対象の関数の定義まで戻れる", () => {
    const ids = prerequisitesOf("M3-BIBUN-KOSEI").map((topic) => topic.id);
    expect(ids).toContain("M2-SANKAKU-KAHO");
    expect(ids).toContain("M2-SHISU-TAISU-KIHON");
  });

  it("depthを増やすと前提の前提までたどる", () => {
    const shallow = prerequisitesOf("M2-ZUKEI-ENCHOKU", 1).map((t) => t.id);
    const deep = prerequisitesOf("M2-ZUKEI-ENCHOKU", 3).map((t) => t.id);
    expect(deep).toEqual(expect.arrayContaining(shallow));
    expect(deep).toContain("M1-NIJI-GURAFU");
  });

  it("未知のIDでは空配列", () => {
    expect(prerequisitesOf("M2-NAI-TOPIC")).toEqual([]);
  });
});

describe("suggestTopics", () => {
  it("写真解析テキストから単元を推定する", () => {
    const ids = suggestTopics("円と直線の位置関係 中心と直線の距離d 半径r 判別式").map((t) => t.id);
    expect(ids[0]).toBe("M2-ZUKEI-ENCHOKU");
  });

  it("キーワードだけでも拾える", () => {
    const ids = suggestTopics("平方完成して頂点を求める").map((t) => t.id);
    expect(ids).toContain("M1-NIJI-GURAFU");
  });

  it("数学と無関係なテキストでは候補を返さない", () => {
    expect(suggestTopics("今日の献立はカレーです")).toEqual([]);
  });

  // `constant` の tan、`since` の sin、`biology` の log を数学の証拠にしない。
  // ここが緩いと、数学以外の写真が「範囲内」として通ってしまう。
  it("英単語に埋もれた sin/tan/log を拾わない", () => {
    expect(suggestTopics("constant biology since")).toEqual([]);
  });

  it("語として書かれた sin は拾う", () => {
    expect(suggestTopics("sin θ の値を求める").map((t) => t.id)).toContain("M1-KEIRYO-SANKAKUHI");
  });

  it("limitが0以下でも空を返す", () => {
    expect(suggestTopics("判別式", 0)).toEqual([]);
    expect(suggestTopics("判別式", -3)).toEqual([]);
  });

  it("limitを超えない", () => {
    expect(suggestTopics("関数 グラフ 微分 積分 数列 ベクトル 確率", 3).length).toBeLessThanOrEqual(
      3,
    );
  });
});
