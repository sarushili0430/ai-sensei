import { topicIdSchema } from "@ai-sensei/contract";
import { isWellFormedTopicId, localeOfTopicId, topics } from "@ai-sensei/curriculum";
import { describe, expect, it } from "vitest";
import { analysisFixture, analysisFixtureEn } from "../test-support.ts";
import {
  curriculumDigest,
  detectImageMediaType,
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

describe("detectImageMediaType", () => {
  function buffer(bytes: number[]): ArrayBuffer {
    return new Uint8Array(bytes).buffer;
  }

  const jpeg = buffer([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = buffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const gif = buffer([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const webp = buffer([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

  it("中身から形式を見分ける", () => {
    expect(detectImageMediaType(jpeg)).toBe("image/jpeg");
    expect(detectImageMediaType(png)).toBe("image/png");
    expect(detectImageMediaType(gif)).toBe("image/gif");
    expect(detectImageMediaType(webp)).toBe("image/webp");
  });

  /**
   * Flutterの MultipartFile は contentType を渡さないと
   * application/octet-stream を送ってくる。これをそのまま media_type にすると
   * Vision APIが400を返し、写真つきのセッション作成が全部500になる。
   */
  it("申告が application/octet-stream でも中身で判断する", () => {
    expect(detectImageMediaType(jpeg, "application/octet-stream")).toBe("image/jpeg");
  });

  it("申告より中身を信じる", () => {
    expect(detectImageMediaType(png, "image/jpeg")).toBe("image/png");
  });

  it("中身から決められないときは、許可リストにある申告だけ使う", () => {
    const unknown = buffer([0x00, 0x01, 0x02, 0x03]);
    expect(detectImageMediaType(unknown, "image/png")).toBe("image/png");
    expect(detectImageMediaType(unknown, "image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(detectImageMediaType(unknown, "IMAGE/JPEG")).toBe("image/jpeg");
  });

  it("Vision APIが受け取れない形式は null にする(投げても400になるため)", () => {
    const heic = buffer([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    expect(detectImageMediaType(heic, "image/heic")).toBeNull();
    expect(detectImageMediaType(heic, "application/octet-stream")).toBeNull();
    expect(detectImageMediaType(heic)).toBeNull();
    expect(detectImageMediaType(new ArrayBuffer(0), "application/pdf")).toBeNull();
  });
});

// 海外向けの課程。ここで日本のカリキュラムを渡していると、
// 英語のノートに「数学II / 図形と方程式」というチップが出る。
describe("課程の切り替え", () => {
  it("英語のセッションには英語のカリキュラムを渡す", () => {
    const prompt = photoAnalysisPrompt("en");
    expect(prompt).toContain("A2-COORD-CIRCLE");
    expect(prompt).toContain("Algebra 2 / Coordinate Geometry");
    expect(prompt).not.toContain("M2-ZUKEI-ENCHOKU");
    expect(prompt).not.toContain("{{");
  });

  it("ダイジェストはその課程のトピックだけを含む", () => {
    expect(curriculumDigest("en")).not.toContain("数学");
    expect(curriculumDigest("ja")).not.toContain("Algebra");
    expect(curriculumDigest("en").split("\n").length).toBeGreaterThanOrEqual(30);
  });

  it("別の課程のtopic_idは落とす(解析器が思い出しで返しても通さない)", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixtureEn,
        topics: [
          { topic_id: "A2-COORD-CIRCLE", confidence: 0.9 },
          { topic_id: "M2-ZUKEI-ENCHOKU", confidence: 0.8 },
        ],
      },
      "en",
    );
    expect(resolved.topicIds).toEqual(["A2-COORD-CIRCLE"]);
    expect(resolved.droppedIds).toEqual(["M2-ZUKEI-ENCHOKU"]);
  });

  it("キーワード推定のフォールバックも課程で絞る", () => {
    const resolved = resolveDetectedTopics({ ...analysisFixtureEn, topics: [] }, "en");
    expect(resolved.topicIds.length).toBeGreaterThan(0);
    for (const id of resolved.topicIds) expect(localeOfTopicId(id)).toBe("en");
  });

  it("チップに出すのは英語の科目名", () => {
    const payload = toDetectedTopicPayload(["A2-COORD-CIRCLE"], analysisFixtureEn);
    expect(payload[0]).toMatchObject({
      topic_id: "A2-COORD-CIRCLE",
      course: "Algebra 2",
      unit: "Coordinate Geometry",
    });
  });
});

/**
 * contract は依存を持たない層なので、topic_idの正規表現を
 * カリキュラム側と二重に書いている。**ここがずれると、カリキュラムには
 * あるのに保存できないトピックができる。**
 */
describe("topic_idの形(contract ↔ curriculum)", () => {
  it("すべてのトピックが contract のスキーマを通る", () => {
    for (const topic of topics) {
      expect(topicIdSchema.safeParse(topic.id).success, topic.id).toBe(true);
      expect(isWellFormedTopicId(topic.id), topic.id).toBe(true);
    }
  });

  it("どちらも同じものを弾く", () => {
    for (const bad of ["大学数学-線形代数", "m2-zukei-enchoku", "XX-FOO", ""]) {
      expect(topicIdSchema.safeParse(bad).success, bad).toBe(false);
      expect(isWellFormedTopicId(bad), bad).toBe(false);
    }
  });
});
