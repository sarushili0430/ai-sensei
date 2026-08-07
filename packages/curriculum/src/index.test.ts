import { describe, expect, it } from "vitest";
import {
  checkIntegrity,
  curriculum,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  prerequisitesOf,
  subjectOfTopicId,
  subjectsOfTopicIds,
  suggestTopics,
  topics,
  topicsByCourse,
  topicsBySubject,
} from "./index.ts";
import { courseNames, subjects } from "./schema.ts";

describe("カリキュラムデータの整合性", () => {
  it("スキーマを満たす(importの時点でparse済み)", () => {
    expect(curriculum.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(topics.length).toBeGreaterThanOrEqual(30);
  });

  it("ID重複・未定義の前提・循環がない", () => {
    expect(checkIntegrity()).toEqual([]);
  });

  it("全コースにトピックがある", () => {
    for (const course of courseNames) {
      expect(topicsByCourse(course).length, `${course} のトピックが空`).toBeGreaterThan(0);
    }
  });

  it("全科目にトピックがある", () => {
    for (const subject of subjects) {
      expect(topicsBySubject(subject).length, `${subject} のトピックが空`).toBeGreaterThan(0);
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

// 英文法は数学と同じ仕組み(単元 → 到達目標 → 質問)に載せる。
// 「訳せますか」ではなく「なぜそう読めるのか」を聞ける形になっているかを見る。
describe("英文法の配当", () => {
  const englishGrammar = topicsBySubject("英文法");

  it("すべて 英文法 コース・EG- 接頭辞になっている", () => {
    for (const topic of englishGrammar) {
      expect(topic.course, topic.id).toBe("英文法");
      expect(topic.id.startsWith("EG-"), topic.id).toBe(true);
    }
  });

  it("高校英文法の主要単元がそろっている", () => {
    const units = new Set(englishGrammar.map((topic) => topic.unit));
    for (const unit of ["時制", "助動詞", "不定詞", "分詞", "関係詞", "仮定法", "比較表現"]) {
      expect(units, `${unit} がない`).toContain(unit);
    }
  });

  it("時制と仮定法がつながっている(仮定法は時制をずらす話なので)", () => {
    const ids = prerequisitesOf("EG-KATEIHO-KAKO-KANRYO", 2).map((topic) => topic.id);
    expect(ids).toContain("EG-KATEIHO-KAKO");
    expect(ids).toContain("EG-JISEI-KAKO-KANRYO");
  });
});

describe("科目の判定", () => {
  it("topic_idから科目を引ける", () => {
    expect(subjectOfTopicId("M2-ZUKEI-ENCHOKU")).toBe("数学");
    expect(subjectOfTopicId("EG-KANKEISHI-DAIMEISHI")).toBe("英文法");
    expect(subjectOfTopicId("M2-SONZAI-SHINAI")).toBeUndefined();
  });

  // 1枚のノートは1科目。混ざったまま許可リストを作ると、
  // 数学のセッションで英文法の質問が通ってしまう。
  it("複数のIDが何科目にまたがるかを返す", () => {
    expect(subjectsOfTopicIds(["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"])).toEqual(["数学"]);
    expect(subjectsOfTopicIds(["M2-ZUKEI-ENCHOKU", "EG-JISEI-SHINKO"])).toHaveLength(2);
    expect(subjectsOfTopicIds([])).toEqual([]);
  });
});

describe("topic_idの判定", () => {
  it("既知のIDを通す", () => {
    expect(isKnownTopicId("M2-ZUKEI-ENCHOKU")).toBe(true);
    expect(isKnownTopicId("EG-JISEI-GENZAI-KANRYO")).toBe(true);
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

  it("どの科目とも無関係なテキストでは候補を返さない", () => {
    expect(suggestTopics("今日の献立はカレーです")).toEqual([]);
  });

  it("英文法のテキストから単元を推定する", () => {
    const ids = suggestTopics("関係代名詞の目的格が省略されている 先行詞はどれか").map((t) => t.id);
    expect(ids[0]).toBe("EG-KANKEISHI-DAIMEISHI");
  });

  // 「比較」「否定」「省略」は数学にも英文法にもある日本語。科目を絞らないと
  // 数学のノートに英文法の単元が混ざる(逆も同じ)。
  it("科目を指定すると、その科目の中からだけ候補を返す", () => {
    const mathOnly = suggestTopics("原級を使った比較", 5, { subject: "数学" });
    expect(mathOnly).toEqual([]);

    const grammarOnly = suggestTopics("判別式 平方完成", 5, { subject: "英文法" });
    expect(grammarOnly).toEqual([]);

    const ids = suggestTopics("原級を使った比較", 5, { subject: "英文法" }).map((t) => t.id);
    expect(ids).toContain("EG-HIKAKU-GENKYU");
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
