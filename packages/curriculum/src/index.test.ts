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
  stageOfTopicId,
  subjectOfTopicId,
  suggestTopics,
  toCurriculumLocale,
  topicLabel,
  topics,
  topicsByCourse,
  topicsForTracks,
  trackOfTopicId,
  tracksForStage,
} from "./index.ts";
import { enCourseNames, jaCourseNames, trackIds, tracks } from "./schema.ts";

describe("カリキュラムデータの整合性", () => {
  it("スキーマを満たす(importの時点でparse済み)", () => {
    for (const track of trackIds) {
      const data = curriculumFor(track);
      expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(data.track).toBe(track);
      // The floor at which one curriculum stands as "one subject's worth of scope".
      // High-school maths has 52/57 entries, but middle-school maths has 27 (3 grades x
      // 4 domains), which is exactly the guidelines' granularity - so imposing the same
      // floor on every curriculum would mean trimming the correct data instead.
      expect(data.topics.length, track).toBeGreaterThanOrEqual(20);
    }
  });

  it("ID重複・未定義の前提・循環がない(全課程横断)", () => {
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

  // A topic with only skill goals ("can factorise") yields questions that amount to
  // "can you solve it?". Every topic carries at least one goal that asks for an explanation.
  it("すべてのトピックに、説明を問える到達目標が最低1つある", () => {
    const explainable: Record<string, RegExp> = {
      ja: /説明できる|使い分け|導ける|判断/,
      en: /\b(explain|justify|decide|choose|say why|say what)\b/i,
    };
    for (const track of trackIds) {
      const pattern = explainable[tracks[track].locale];
      for (const topic of topicsForTracks([track])) {
        expect(
          topic.goals.some((goal) => pattern?.test(goal)),
          topic.id,
        ).toBe(true);
      }
    }
  });

  // Colliding prefixes make it impossible to decide a curriculum from a hole's tag.
  // Language, subject and school stage all come from that first component, so breaking
  // this decides neither the notification's language nor the usable board elements.
  it("topic_idの接頭辞は課程をまたいで重複しない", () => {
    for (const track of trackIds) {
      for (const topic of topicsForTracks([track])) {
        expect(trackOfTopicId(topic.id), topic.id).toBe(track);
        expect(localeOfTopicId(topic.id), topic.id).toBe(tracks[track].locale);
        expect(subjectOfTopicId(topic.id), topic.id).toBe(tracks[track].subject);
        expect(stageOfTopicId(topic.id), topic.id).toBe(tracks[track].stage);
      }
    }
  });

  it("別の言語・別の教科をまたいだ前提参照がない", () => {
    const issues = checkIntegrity();
    expect(issues.filter((issue) => issue.kind === "cross-curriculum-prerequisite")).toEqual([]);
  });
});

// Pitfalls of the current guidelines (from 2022). Adding entries from the old guidelines always fails here.
describe("新課程の配当", () => {
  const jaTopics = topicsForTracks(["hs_math_ja"]);

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

// The overseas curricula are not translations of the Japanese ones. Adding a
// re-translation would put a course name like "Math II" - which exists nowhere - on screen.
describe("海外向けの課程の配当", () => {
  it("科目名は Algebra / Geometry などで、数学I〜C の訳語ではない", () => {
    const names = new Set(curricula.hs_math_en.courses.map((course) => course.name));
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

describe("課程(track)", () => {
  // Cutting by stage leaves that student exactly as many curricula as subjects.
  // It is why Math I-C never lists for a middle-schooler and grade-7 units never list
  // for a high-schooler.
  it("段階と指導言語から課程を引ける", () => {
    expect(tracksForStage("high_school", "ja").sort()).toEqual(["hs_english_ja", "hs_math_ja"]);
    expect(tracksForStage("junior_high", "ja").sort()).toEqual(["jhs_english_ja", "jhs_math_ja"]);
    expect(tracksForStage("high_school", "en")).toEqual(["hs_math_en"]);
  });

  // The overseas curricula run continuously from Algebra 1 to Calculus, with no
  // middle/high split. Cutting by stage would leave English learners with nothing.
  it("海外向けの課程は段階で切らない", () => {
    expect(tracksForStage("junior_high", "en")).toEqual(["hs_math_en"]);
  });

  it("課程を指定しないと全課程のトピックが返る", () => {
    expect(topicsForTracks(trackIds).length).toBe(topics.length);
  });

  it("知らない接頭辞では課程が引けない", () => {
    expect(trackOfTopicId("XX-NANIKA")).toBeUndefined();
    expect(localeOfTopicId("XX-NANIKA")).toBeUndefined();
    expect(subjectOfTopicId("XX-NANIKA")).toBeUndefined();
  });
});

describe("topicLabel", () => {
  it("科目の短い名前を返す", () => {
    const topic = findTopic("M2-ZUKEI-ENCHOKU");
    expect(topic && topicLabel(topic)).toBe("数学II");
  });

  it("海外向けの課程でも科目名を返す", () => {
    const topic = findTopic("A2-COORD-CIRCLE");
    expect(topic && topicLabel(topic)).toBe("Algebra 2");
  });

  // Only English curricula carry a rough grade, because grade allocation differs per
  // textbook. In maths the course itself is the grade, so a grade_hint would be duplicate bookkeeping.
  it("数学の課程に grade_hint を書くと整合性検査で落ちる", () => {
    const [sample] = curricula.hs_math_ja.topics;
    if (!sample) throw new Error("トピックが空です");
    const issues = checkIntegrity({
      ...curricula.hs_math_ja,
      topics: [{ ...sample, grade_hint: 1 }],
    });
    expect(issues.map((issue) => issue.kind)).toContain("grade-hint-not-allowed");
  });

  it("宣言だけしてトピックが無いコースは整合性検査で落ちる", () => {
    const issues = checkIntegrity({
      ...curricula.hs_math_ja,
      topics: curricula.hs_math_ja.topics.filter((topic) => topic.course === "数学I"),
    });
    expect(issues.filter((issue) => issue.kind === "empty-course").length).toBeGreaterThan(0);
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

  it("海外の課程でも前提をたどれる(深掘りは同じ言語・同じ教科の中で閉じる)", () => {
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

  // Space-separated English words lose their word boundaries if spaces are removed:
  // `law of sines` would hide inside `usingthelawofsines` and never match.
  it("複数語の英語キーワードを拾える", () => {
    const ids = suggestTopics("we used the law of sines to find the missing angle").map(
      (t) => t.id,
    );
    expect(ids).toContain("GE-TRIG-LAWS");
  });

  it("課程を指定すると、その課程からだけ候補を返す", () => {
    const ids = suggestTopics("distance from the center to the line and the radius", 5, {
      tracks: ["hs_math_en"],
    }).map((t) => t.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(trackOfTopicId(id)).toBe("hs_math_en");
  });

  it("数学と無関係なテキストでは候補を返さない", () => {
    expect(suggestTopics("今日の献立はカレーです")).toEqual([]);
  });

  // The tan in `constant`, the sin in `since` and the log in `biology` are not evidence
  // of maths. Loosen this and non-maths photos pass as "in scope".
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
