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
      is_math_note: true,
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
      is_math_note: false,
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
 * 問題文もLLMの出力なので、topic_id と同じく**そのまま信じない一段**を通す
 * (計画書 §0 決定4「問題とノートをセットで送る」の受け口)。
 */
describe("resolveSessionProblem", () => {
  it("読めた問題文を、どちらの写真から来たかと一緒に返す", () => {
    expect(resolveSessionProblem({ analysis: analysisFixture, hadProblemPhoto: true })).toEqual({
      problem: { text: analysisFixture.problem_text, source: "problem_photo" },
      outcome: "read",
    });
  });

  // 1枚に問題とノートの両方が写るケース(§4-1 が「多い」と書いているほう)。
  it("問題の写真が無ければ、ノートから読んだものとして記録する", () => {
    const resolved = resolveSessionProblem({ analysis: analysisFixture, hadProblemPhoto: false });
    expect(resolved.problem?.source).toBe("notes_photo");
  });

  // 問題が読めないのは失敗ではない。先輩が「問題、読んでもらってもいい?」から始める。
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
   * 上限超えは「紙面を丸ごと書き起こした」とき。先頭で切ると設問の途中で切れた問題を
   * 教えることになり、章末の解答まで混ざっている可能性も高い。**切らずに捨てる。**
   */
  it("上限を超えた問題文は切らずに捨て、not_found と区別できる形で返す", () => {
    const resolved = resolveSessionProblem({
      analysis: { ...analysisFixture, problem_text: "あ".repeat(problemTextMaxLength + 1) },
      hadProblemPhoto: true,
    });
    expect(resolved).toEqual({ problem: null, outcome: "too_long" });
  });

  /**
   * `@ai-sensei/guardrail` の `checkProblemText()` を通していること。
   * **ガードだけあって呼ばれていない状態は「入れたつもり」で運用に入る**ので、
   * 「繋がっている」ことをここで固定する。
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
   * **弾く条件はこちら側で足さない。** guardrail が「迷ったら通す」で書いてあるので、
   * ここに独自の条件を足すと方針が2か所に分かれ、どこまで厳しいのかが読めなくなる。
   * ふつうの設問がそのまま通ることを、境目の例で押さえておく。
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
   * 落ち方を `not_found` にまとめない。`too_long` が続けば600字の指示が、
   * `solution_included` が続けば「解答は取らない」の指示が効いていないと読み分けられる。
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

  // contract 側のスキーマと、ここが通す値の範囲がずれていないこと。
  it("返す問題は contract のスキーマを満たす", () => {
    const resolved = resolveSessionProblem({ analysis: analysisFixture, hadProblemPhoto: true });
    expect(sessionProblemSchema.safeParse(resolved.problem).success).toBe(true);
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
