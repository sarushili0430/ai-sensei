import { describe, expect, it } from "vitest";
import { analysisFixture } from "../test-support.ts";
import {
  curriculumDigest,
  extractJson,
  photoAnalysisPrompt,
  photoAnalysisSchema,
  resolveDetectedTopics,
  toDetectedTopicPayload,
} from "./photo-analysis.ts";

describe("photoAnalysisPrompt", () => {
  it("カリキュラムマップを埋め込む", () => {
    const prompt = photoAnalysisPrompt();
    expect(prompt).toContain("M2-ZUKEI-ENCHOKU");
    expect(prompt).not.toContain("{{");
  });

  it("ダイジェストは全トピックを含む", () => {
    expect(curriculumDigest().split("\n").length).toBeGreaterThanOrEqual(30);
  });
});

describe("extractJson", () => {
  it("コードフェンス付きの出力から拾う", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("前置きが付いていても拾う", () => {
    expect(extractJson('解析しました。\n{"a":1}')).toEqual({ a: 1 });
  });

  it("JSONがなければエラー", () => {
    expect(() => extractJson("読み取れませんでした")).toThrow();
  });
});

describe("resolveDetectedTopics", () => {
  it("既知のtopic_idだけを許可リストに入れる", () => {
    const resolved = resolveDetectedTopics({
      ...analysisFixture,
      topics: [
        { topic_id: "M2-ZUKEI-ENCHOKU", confidence: 0.9 },
        { topic_id: "MX-SENKEI-DAISU", confidence: 0.8 },
      ],
    });
    expect(resolved.topicIds).toEqual(["M2-ZUKEI-ENCHOKU"]);
    expect(resolved.droppedIds).toEqual(["MX-SENKEI-DAISU"]);
  });

  it("LLMがtopic_idを返さなくてもキーワードから拾う", () => {
    const resolved = resolveDetectedTopics({
      is_math_note: true,
      summary: "平方完成して頂点を求める問題",
      visible_work: [],
      topics: [],
      unreadable: [],
      question_seeds: [],
    });
    expect(resolved.topicIds).toContain("M1-NIJI-GURAFU");
  });

  it("数学のノートでなければフォールバックもしない", () => {
    const resolved = resolveDetectedTopics({
      is_math_note: false,
      summary: "英語の単語帳。関数という言葉だけ写っている",
      visible_work: [],
      topics: [],
      unreadable: [],
      question_seeds: [],
    });
    expect(resolved.topicIds).toEqual([]);
  });
});

describe("toDetectedTopicPayload", () => {
  it("カリキュラムの単元名を補って返す", () => {
    const payload = toDetectedTopicPayload(["M2-ZUKEI-ENCHOKU"], analysisFixture);
    expect(payload[0]).toEqual({
      topic_id: "M2-ZUKEI-ENCHOKU",
      course: "数学II",
      unit: "図形と方程式",
      topic: "円と直線の位置関係",
      confidence: 0.92,
    });
  });

  it("キーワード推定にフォールバックした分は確信度を低くする", () => {
    const payload = toDetectedTopicPayload(["M1-NIJI-GURAFU"], {
      ...analysisFixture,
      topics: [],
    });
    expect(payload[0]?.confidence).toBe(0.4);
  });
});

describe("photoAnalysisSchema", () => {
  it("欠けた配列を空で補う(LLMの出力ゆれを吸収する)", () => {
    const parsed = photoAnalysisSchema.parse({ is_math_note: true, summary: "円と直線" });
    expect(parsed.topics).toEqual([]);
    expect(parsed.question_seeds).toEqual([]);
  });
});
