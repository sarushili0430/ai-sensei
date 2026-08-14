import { problemTextMaxLength, sessionProblemSchema, topicIdSchema } from "@ai-sensei/contract";
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
  resolveSessionProblem,
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
      subject: "math",
      summary: "平方完成して頂点を求める問題",
      problem_text: "",
      visible_work: [],
      topics: [],
      unreadable: [],
      question_seeds: [],
    });
    expect(resolved.topicIds).toContain("M1-NIJI-GURAFU");
  });

  it("数学のノートでなければフォールバックもしない", () => {
    const resolved = resolveDetectedTopics({
      subject: "other",
      summary: "英語の単語帳。関数という言葉だけ写っている",
      problem_text: "",
      visible_work: [],
      topics: [],
      unreadable: [],
      question_seeds: [],
    });
    expect(resolved.topicIds).toEqual([]);
  });
});

/**
 * The problem text is LLM output too, so like topic_id it goes through a layer
 * that does not trust it (the receiving end of plan §0 decision 4, "send the
 * problem and the notes together").
 */
describe("resolveSessionProblem", () => {
  it("読めた問題文を、どちらの写真から来たかと一緒に返す", () => {
    expect(resolveSessionProblem({ analysis: analysisFixture, hadProblemPhoto: true })).toEqual({
      problem: { text: analysisFixture.problem_text, source: "problem_photo" },
      outcome: "read",
    });
  });

  // The case where one photo holds both the problem and the notes (§4-1 calls it common).
  it("問題の写真が無ければ、ノートから読んだものとして記録する", () => {
    const resolved = resolveSessionProblem({ analysis: analysisFixture, hadProblemPhoto: false });
    expect(resolved.problem?.source).toBe("notes_photo");
  });

  // An unreadable problem is not a failure. The senpai opens with "could you read the problem out?".
  it("空・空白だけ・解析なしは not_found(セッションは止めない)", () => {
    for (const analysis of [
      { ...analysisFixture, problem_text: "" },
      { ...analysisFixture, problem_text: "   \n " },
      null,
    ]) {
      expect(resolveSessionProblem({ analysis, hadProblemPhoto: false })).toEqual({
        problem: null,
        outcome: "not_found",
      });
    }
  });

  /**
   * Exceeding the cap means the whole page was transcribed. Truncating would teach
   * a problem cut mid-question, and the chapter's answers are likely mixed in.
   * Discard it whole.
   */
  it("上限を超えた問題文は切らずに捨て、not_found と区別できる形で返す", () => {
    const resolved = resolveSessionProblem({
      analysis: { ...analysisFixture, problem_text: "あ".repeat(problemTextMaxLength + 1) },
      hadProblemPhoto: true,
    });
    expect(resolved).toEqual({ problem: null, outcome: "too_long" });
  });

  /**
   * Confirms `checkProblemText()` from `@ai-sensei/guardrail` is actually called.
   * A guard that exists but is never invoked ships as "we added it", so "it is
   * wired" is pinned here.
   */
  it("解答が混ざった問題文を落とす(guardrailを通している)", () => {
    const resolved = resolveSessionProblem({
      analysis: {
        ...analysisFixture,
        problem_text: "x^2 - 3x + 2 = 0 を解け。 【解答】x = 1, 2",
      },
      hadProblemPhoto: true,
    });
    expect(resolved).toEqual({ problem: null, outcome: "solution_included" });
  });

  it("設問の無い式だけの断片を落とす", () => {
    const resolved = resolveSessionProblem({
      analysis: { ...analysisFixture, problem_text: "x^2 - 3x + 2 = 0" },
      hadProblemPhoto: true,
    });
    expect(resolved).toEqual({ problem: null, outcome: "not_a_problem" });
  });

  /**
   * Do not add rejection conditions on this side. The guardrail is written to pass
   * when unsure, so extra conditions here would split the policy across two places
   * and make its strictness unreadable. Pin that ordinary questions pass, using
   * borderline examples.
   */
  it("「解答用紙」「答えを求めよ」を含むふつうの設問は通す", () => {
    for (const problemText of [
      "解答用紙に途中式も書くこと。x^2 - 3x + 2 = 0 を解け。",
      "答えは小数第2位を四捨五入して求めよ。",
    ]) {
      const resolved = resolveSessionProblem({
        analysis: { ...analysisFixture, problem_text: problemText },
        hadProblemPhoto: false,
      });
      expect(resolved.outcome, problemText).toBe("read");
    }
  });

  /**
   * The failures are not collapsed into `not_found`: repeated `too_long` means the
   * 600-char instruction is not landing, repeated `solution_included` means "do not
   * take the answers" is not landing.
   */
  it("落ちた理由がログで読み分けられる(全部 not_found にしない)", () => {
    const outcomes = [
      "",
      "あ".repeat(problemTextMaxLength + 1),
      "解け。【解答】x = 1",
      "x = 1",
    ].map(
      (problem_text) =>
        resolveSessionProblem({
          analysis: { ...analysisFixture, problem_text },
          hadProblemPhoto: true,
        }).outcome,
    );
    expect(new Set(outcomes).size).toBe(outcomes.length);
  });

  it("上限ちょうどは通す", () => {
    const resolved = resolveSessionProblem({
      analysis: { ...analysisFixture, problem_text: "あ".repeat(problemTextMaxLength) },
      hadProblemPhoto: true,
    });
    expect(resolved.outcome).toBe("read");
  });

  // The contract-side schema and the range of values this passes must not drift.
  it("返す問題は contract のスキーマを満たす", () => {
    const resolved = resolveSessionProblem({ analysis: analysisFixture, hadProblemPhoto: true });
    expect(sessionProblemSchema.safeParse(resolved.problem).success).toBe(true);
  });
});

/**
 * The list pasted for the analyser is halved by school stage. Pasting every
 * curriculum lists all 52 Math I-C entries as candidates for a middle-schooler's
 * photo and lets the analyser pick a high-school unit.
 */
describe("curriculumDigest", () => {
  it("中学生には中学の課程だけを貼る", () => {
    const digest = curriculumDigest("ja", "junior_high");
    expect(digest).toContain("J1-KAZUSHIKI-SEIFU");
    expect(digest).not.toContain("M1-");
  });

  it("既定は高校。学校段階を送らない古いアプリは今までどおり", () => {
    const digest = curriculumDigest("ja");
    expect(digest).toContain("M1-");
    expect(digest).not.toContain("J1-");
  });

  it("海外向けの課程は段階で切らない(Algebra 1 〜 Calculus が一続きのため)", () => {
    expect(curriculumDigest("en", "junior_high")).toBe(curriculumDigest("en", "high_school"));
  });
});

describe("resolveDetectedTopics", () => {
  // Units outside the stage do not pass even if the analyser returns them. Math II
  // mixed into a middle-schooler's session becomes an allowed topic and gets taught.
  it("段階の外の単元は落とす", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixture,
        topics: [
          { topic_id: "J1-KAZUSHIKI-SEIFU", confidence: 0.9 },
          { topic_id: "M2-ZUKEI-ENCHOKU", confidence: 0.8 },
        ],
      },
      "ja",
      "junior_high",
    );
    expect(resolved.topicIds).toEqual(["J1-KAZUSHIKI-SEIFU"]);
    expect(resolved.droppedIds).toContain("M2-ZUKEI-ENCHOKU");
  });
});

/**
 * Getting the subject wrong affects the entire lesson. The agent's `subjectOf()`
 * decides the subject from the first allowed topic, so one math id mixed into an
 * English photo - if it comes first - makes both the board and the spoken-math
 * corrections math.
 */
describe("resolveDetectedTopics(教科での絞り込み)", () => {
  it("英語の写真に混ざった数学の単元は落とす", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixture,
        subject: "english",
        topics: [
          { topic_id: "J2-KANSU-ICHIJI", confidence: 0.9 },
          { topic_id: "JE-FUTEISHI", confidence: 0.8 },
        ],
      },
      "ja",
      "junior_high",
    );
    expect(resolved.topicIds).toEqual(["JE-FUTEISHI"]);
    expect(resolved.droppedIds).toContain("J2-KANSU-ICHIJI");
  });

  it("数学の写真に混ざった英語の単元も落とす", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixture,
        subject: "math",
        topics: [
          { topic_id: "JE-FUTEISHI", confidence: 0.9 },
          { topic_id: "J2-KANSU-ICHIJI", confidence: 0.8 },
        ],
      },
      "ja",
      "junior_high",
    );
    expect(resolved.topicIds).toEqual(["J2-KANSU-ICHIJI"]);
  });

  // Keyword inference is closed within the subject too. A leak here lands an English
  // photo on a math unit just because its summary contains the word "function".
  it("キーワード推定も教科の中で閉じる", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixture,
        subject: "english",
        summary: "一次関数のグラフ",
        problem_text: "",
        visible_work: [],
        topics: [],
        question_seeds: [],
      },
      "ja",
      "junior_high",
    );
    for (const id of resolved.topicIds) expect(id.startsWith("JE-")).toBe(true);
  });
});

/**
 * An English notebook never says "to-infinitive": it contains English sentences,
 * so a keyword miss is the default path, not an anomaly. Returning empty here
 * would get a perfectly readable photo rejected by the caller as
 * `photo_unreadable`.
 */
describe("resolveDetectedTopics(着地点)", () => {
  it("英語でキーワードが空振りしたら、その課程の着地点に降ろす", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixture,
        subject: "english",
        summary: "Yesterday I went to the park with my friends.",
        problem_text: "",
        visible_work: [],
        topics: [],
        question_seeds: [],
      },
      "ja",
      "junior_high",
    );
    expect(resolved.topicIds).toEqual(["JE-BUNKOZO-KIHON"]);
  });

  it("高校英語にも着地点がある", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixture,
        subject: "english",
        summary: "The passage describes a small town by the sea.",
        problem_text: "",
        visible_work: [],
        topics: [],
        question_seeds: [],
      },
      "ja",
      "high_school",
    );
    expect(resolved.topicIds).toEqual(["E1-DOKKAI-YOTEN"]);
  });

  // Math has no landing point (keywords work, so it does not need one).
  // It returns empty as before and the caller prompts a retake.
  it("数学は着地点を持たず、空のまま返す", () => {
    const resolved = resolveDetectedTopics(
      {
        ...analysisFixture,
        subject: "math",
        summary: "なにも読み取れない",
        problem_text: "",
        visible_work: [],
        topics: [],
        question_seeds: [],
      },
      "ja",
      "junior_high",
    );
    expect(resolved.topicIds).toEqual([]);
  });

  it("範囲外(other)では着地点も使わない", () => {
    const resolved = resolveDetectedTopics(
      { ...analysisFixture, subject: "other", topics: [], question_seeds: [] },
      "ja",
      "junior_high",
    );
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
      label: "数学II",
      confidence: 0.92,
    });
  });

  // Chips read like "Grade 7 - positive and negative numbers". High-school math uses
  // the course name as the short label, but middle school uses the grade (the
  // curriculum guidelines split by grade, so course represents the grade).
  it("中学の単元では、チップのラベルが学年になる", () => {
    const payload = toDetectedTopicPayload(["J1-KAZUSHIKI-SEIFU"], {
      ...analysisFixture,
      topics: [{ topic_id: "J1-KAZUSHIKI-SEIFU", confidence: 0.9 }],
    });
    expect(payload[0]?.label).toBe("中1");
    expect(payload[0]?.topic).toBe("正負の数");
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
    const parsed = photoAnalysisSchema.parse({ subject: "math", summary: "円と直線" });
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
   * Flutter's MultipartFile sends application/octet-stream unless contentType is
   * given. Passing that straight into media_type makes the Vision API return 400,
   * so every photo session creation becomes a 500.
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

// Overseas curricula. Handing the Japanese curriculum here would put a
// "Math II / coordinate geometry" chip on an English notebook.
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
 * contract is a dependency-free layer, so the topic_id regex is written twice -
 * here and on the curriculum side. Drift creates topics that exist in the
 * curriculum but cannot be stored.
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
