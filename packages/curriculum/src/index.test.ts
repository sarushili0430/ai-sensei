import { describe, expect, it } from "vitest";
import {
  checkIntegrity,
  curricula,
  curriculumFor,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  localeOfTopicId,
  prerequisitesOf,
  suggestTopics,
  toCurriculumLocale,
  topics,
  topicsByCourse,
  topicsFor,
} from "./index.ts";
import { curriculumLocales, enCourseNames, jaCourseNames } from "./schema.ts";

describe("カリキュラムデータの整合性", () => {
  it("スキーマを満たす(importの時点でparse済み)", () => {
    for (const locale of curriculumLocales) {
      const data = curriculumFor(locale);
      expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(data.locale).toBe(locale);
      expect(data.topics.length, locale).toBeGreaterThanOrEqual(30);
    }
  });

  it("ID重複・未定義の前提・循環がない(全ロケール横断)", () => {
    expect(checkIntegrity()).toEqual([]);
  });

  it("日本の課程の6科目すべてにトピックがある", () => {
    for (const course of jaCourseNames) {
      expect(topicsByCourse(course).length, `${course} のトピックが空`).toBeGreaterThan(0);
    }
  });

  it("海外向けの課程の6コースすべてにトピックがある", () => {
    for (const course of enCourseNames) {
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
    const explainable: Record<string, RegExp> = {
      ja: /説明できる|使い分け|導ける|判断/,
      en: /\b(explain|justify|decide|choose|say why|say what)\b/i,
    };
    for (const locale of curriculumLocales) {
      for (const topic of topicsFor(locale)) {
        expect(
          topic.goals.some((goal) => explainable[locale]?.test(goal)),
          topic.id,
        ).toBe(true);
      }
    }
  });

  // 接頭辞がぶつかると、穴のタグからどちらの課程か決められなくなる。
  it("topic_idの接頭辞はロケールをまたいで重複しない", () => {
    for (const topic of topicsFor("ja")) {
      expect(localeOfTopicId(topic.id), topic.id).toBe("ja");
    }
    for (const topic of topicsFor("en")) {
      expect(localeOfTopicId(topic.id), topic.id).toBe("en");
    }
  });

  it("課程をまたいだ前提参照がない", () => {
    const issues = checkIntegrity();
    expect(issues.filter((issue) => issue.kind === "cross-curriculum-prerequisite")).toEqual([]);
  });
});

// 新課程(2022年度〜)の要注意点。旧課程の知識で書き足すと必ずここで落ちる。
describe("新課程の配当", () => {
  const jaTopics = topicsFor("ja");

  it("ベクトルは数学B ではなく 数学C にある", () => {
    const vectorTopics = jaTopics.filter((topic) => topic.unit === "ベクトル");
    expect(vectorTopics.length).toBeGreaterThan(0);
    for (const topic of vectorTopics) {
      expect(topic.course, topic.id).toBe("数学C");
    }
  });

  it("統計的な推測は数学Bにある", () => {
    const statistics = jaTopics.filter((topic) => topic.unit === "統計的な推測");
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

// 海外の課程は日本の課程の翻訳ではない。訳し直したものを足すと、
// 「Math II」のようなどこの国にも無い科目名が画面に出てしまう。
describe("海外向けの課程の配当", () => {
  it("科目名は Algebra / Geometry などで、数学I〜C の訳語ではない", () => {
    const names = new Set(curricula.en.courses.map((course) => course.name));
    expect(names).toEqual(new Set(enCourseNames));
    for (const name of names) {
      expect(name).not.toMatch(/Math\s*(I|II|III|A|B|C)\b/);
    }
  });

  it("微積分は Calculus に、確率・統計は Statistics にある", () => {
    expect(findTopic("CL-INT-AREA")?.course).toBe("Calculus");
    expect(findTopic("ST-PROB-CONDITIONAL")?.course).toBe("Statistics");
  });

  it("ベクトルと複素数平面は Precalculus にある", () => {
    expect(findTopic("PC-VECTOR-DOT")?.course).toBe("Precalculus");
    expect(findTopic("PC-COMPLEX-POLAR")?.course).toBe("Precalculus");
  });
});

describe("topic_idの判定", () => {
  it("既知のIDを通す(日本・海外どちらも)", () => {
    expect(isKnownTopicId("M2-ZUKEI-ENCHOKU")).toBe(true);
    expect(isKnownTopicId("A2-COORD-CIRCLE")).toBe(true);
  });

  it("形は正しいが未定義のIDを弾く", () => {
    expect(isWellFormedTopicId("M2-SONZAI-SHINAI")).toBe(true);
    expect(isKnownTopicId("M2-SONZAI-SHINAI")).toBe(false);
    expect(isWellFormedTopicId("A1-NOT-A-TOPIC")).toBe(true);
    expect(isKnownTopicId("A1-NOT-A-TOPIC")).toBe(false);
  });

  it("形の壊れたIDを弾く", () => {
    expect(isWellFormedTopicId("大学数学-線形代数")).toBe(false);
    expect(isWellFormedTopicId("m2-zukei-enchoku")).toBe(false);
    expect(isWellFormedTopicId("ALGEBRA-1-SLOPE")).toBe(false);
    expect(isWellFormedTopicId("")).toBe(false);
  });

  it("未知のロケールは日本の課程に丸める", () => {
    expect(toCurriculumLocale("en")).toBe("en");
    expect(toCurriculumLocale("fr")).toBe("ja");
    expect(toCurriculumLocale(undefined)).toBe("ja");
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

  it("海外の課程でも前提をたどれる(深掘りは同じ課程の中で閉じる)", () => {
    const ids = prerequisitesOf("A2-COORD-CIRCLE", 2).map((topic) => topic.id);
    expect(ids).toContain("A1-QUAD-SOLVE");
    expect(ids).toContain("A1-QUAD-GRAPH");
    for (const id of ids) expect(localeOfTopicId(id)).toBe("en");
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

  it("英語のノートからは海外向けの単元を引く", () => {
    const ids = suggestTopics("using the quadratic formula, the discriminant is negative").map(
      (t) => t.id,
    );
    expect(ids[0]).toBe("A1-QUAD-SOLVE");
  });

  // 空白で区切られた英語の語は、空白を落とすと語境界を失う。
  // `law of sines` が `usingthelawofsines` の中に埋もれて一致しなくなる。
  it("複数語の英語キーワードを拾える", () => {
    const ids = suggestTopics("we used the law of sines to find the missing angle").map(
      (t) => t.id,
    );
    expect(ids).toContain("GE-TRIG-LAWS");
  });

  it("localeを指定すると、その課程からだけ候補を返す", () => {
    const ids = suggestTopics("distance from the center to the line and the radius", 5, {
      locale: "en",
    }).map((t) => t.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(localeOfTopicId(id)).toBe("en");
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
