import { describe, expect, it } from "vitest";
import {
  InvalidSessionContextError,
  readSessionContext,
  remainingSeconds,
  resolveSessionContext,
} from "./context.ts";

const metadata = JSON.stringify({
  session_id: "ses_1",
  problem_text: "x^2 - 3x + 2 = 0 を解け",
  locale: "ja",
  kind: "new",
  max_seconds: 300,
  photo_summary: "円と直線の位置関係の問題",
  visible_work: "- 中心と直線の距離を求めている",
  question_seeds: "- 方法を変えた理由",
  allowed_topics: "- M2-ZUKEI-ENCHOKU — 数学II / 図形と方程式 / 円と直線の位置関係",
  allowed_topic_ids: ["M2-ZUKEI-ENCHOKU", "M1-NIJI-HANBETSU"],
  is_premium: false,
});

describe("readSessionContext", () => {
  it("トークンのmetadataから会話文脈を読む", () => {
    const context = readSessionContext(metadata);
    expect(context.session_id).toBe("ses_1");
    expect(context.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
    expect(context.max_seconds).toBe(300);
  });

  // 文脈なしで喋らせると、写真と関係ない一般論を聞き始めてしまう
  it("metadataが空なら会話を始めない", () => {
    expect(() => readSessionContext(undefined)).toThrow(InvalidSessionContextError);
    expect(() => readSessionContext("")).toThrow(InvalidSessionContextError);
  });

  it("JSONでなければ会話を始めない", () => {
    expect(() => readSessionContext("not json")).toThrow(InvalidSessionContextError);
  });

  it("許可トピックが空なら会話を始めない", () => {
    const empty = JSON.stringify({ ...JSON.parse(metadata), allowed_topic_ids: [] });
    expect(() => readSessionContext(empty)).toThrow(/許可トピックが空/);
  });

  /**
   * `problem_text` と `visible_work` は**agent側で埋めない**。
   *
   * 契約(`sessionMetadataSchema`)が `.min(1)` を保証していて、読めなかったとき・
   * ノートが無いときのプレースホルダまで backend/api が会話の言語で入れてくる。
   * ここで空を埋めると文言を作る場所が2つになり、`senpai_board.<locale>.md` が
   * **名指しで見ている**プレースホルダとずれて、分岐が発火しない。
   *
   * 欠けて届くのは版ずれなので、**会話を始めずに落とす**のが正しい。
   * 空の問題文で授業を始めると、生徒はまるごと間違った問題を教わる。
   */
  it("問題文が欠けていたら会話を始めない", () => {
    const { problem_text, ...rest } = JSON.parse(metadata);
    expect(() => readSessionContext(JSON.stringify(rest))).toThrow(InvalidSessionContextError);
    expect(() => readSessionContext(JSON.stringify({ ...rest, problem_text: "" }))).toThrow(
      InvalidSessionContextError,
    );
  });

  // ノートが無い経路(問題だけを撮った生徒)でも、契約側が
  // 「(ノートの写真なし)」を入れて送ってくるので、空では届かない。
  it("ノートの欄が欠けていたら会話を始めない", () => {
    const { visible_work, ...rest } = JSON.parse(metadata);
    expect(() => readSessionContext(JSON.stringify(rest))).toThrow(InvalidSessionContextError);
  });

  it("ノートが無い経路のプレースホルダは、そのまま素通しする", () => {
    const noNotes = JSON.stringify({
      ...JSON.parse(metadata),
      visible_work: "(ノートの写真なし)",
    });
    expect(readSessionContext(noNotes).visible_work).toBe("(ノートの写真なし)");
  });

  // `question_seeds` は契約側が空を許しているので、ここだけは受ける。
  // 文言は backend/api と同じ `formatBullets([])` から取るのでずれない。
  it("質問の種が空なら、会話の言語で「なし」を入れる", () => {
    const { question_seeds, ...rest } = JSON.parse(metadata);

    expect(readSessionContext(JSON.stringify(rest)).question_seeds).toBe("(なし)");
    expect(readSessionContext(JSON.stringify({ ...rest, locale: "en" })).question_seeds).toBe(
      "(none)",
    );
  });

  it("必須項目が欠けていれば会話を始めない", () => {
    const broken = JSON.stringify({ session_id: "ses_1" });
    expect(() => readSessionContext(broken)).toThrow(InvalidSessionContextError);
  });

  it("将来サーバが項目を足しても壊れない(passthrough)", () => {
    const extended = JSON.stringify({ ...JSON.parse(metadata), future_field: "x" });
    expect(readSessionContext(extended).session_id).toBe("ses_1");
  });
});

describe("resolveSessionContext", () => {
  it("参加者metadataが読めればそれを使う", () => {
    expect(resolveSessionContext([metadata, undefined]).session_id).toBe("ses_1");
  });

  // 明示ディスパッチでは、文脈はジョブ側に載って来る
  it("参加者metadataが空でも、ジョブmetadataから読める", () => {
    expect(resolveSessionContext([undefined, metadata]).session_id).toBe("ses_1");
    expect(resolveSessionContext(["", metadata]).session_id).toBe("ses_1");
  });

  it("壊れたmetadataは飛ばして、読めるほうを使う", () => {
    expect(resolveSessionContext(["not json", metadata]).session_id).toBe("ses_1");
  });

  it("どこにも載っていなければ会話を始めない", () => {
    expect(() => resolveSessionContext([undefined, null])).toThrow(InvalidSessionContextError);
    expect(() => resolveSessionContext(["not json", ""])).toThrow(InvalidSessionContextError);
  });
});

describe("remainingSeconds", () => {
  const context = readSessionContext(metadata);
  const startedAt = new Date("2026-08-03T13:00:00.000Z");

  it("経過ぶんを引く", () => {
    expect(remainingSeconds(context, startedAt, new Date("2026-08-03T13:01:00.000Z"))).toBe(240);
  });

  it("超過しても負にならない", () => {
    expect(remainingSeconds(context, startedAt, new Date("2026-08-03T13:10:00.000Z"))).toBe(0);
  });
});
