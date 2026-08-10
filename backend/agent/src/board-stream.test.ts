import { describe, expect, it } from "vitest";
import {
  BoardLessonStreamParser,
  BoardStreamError,
  type BoardStreamEvent,
  boardStreamMaxLength,
} from "./board-stream.ts";

/**
 * 逐次パースのテスト。見たいのは「読めること」ではなく、
 * **手順が閉じた瞬間に1つだけ出ること**と、**壊れたときに壊れたと分かること**。
 */

const lesson = {
  title: "判別式で解の個数を見る",
  topic_ids: ["M1-NIJI-HANBETSU"],
  steps: [
    {
      index: 0,
      speech: "まず、この式からいくね。",
      board: { kind: "latex", tex: "x^2 - 3x + 2 = 0" },
    },
    {
      index: 1,
      speech: "ここ、Dを見てほしいんだけど。",
      board: { kind: "latex", tex: "D = 9 - 8 = 1" },
    },
    { index: 2, speech: "だから、解はいくつになると思う?", board: null },
  ],
};

const lessonJson = JSON.stringify(lesson);

/** チャンクの切れ目を機械的に作る(切れ目の位置に意味を持たせない)。 */
function slice(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts;
}

/** 1チャンクずつ食べさせて、各チャンクで何が出たかを並べて返す。 */
function feedAll(parts: readonly string[]): {
  parser: BoardLessonStreamParser;
  perChunk: BoardStreamEvent[][];
  events: BoardStreamEvent[];
} {
  const parser = new BoardLessonStreamParser();
  const perChunk = parts.map((part) => parser.feed(part));
  return { parser, perChunk, events: perChunk.flat() };
}

const stepsOf = (events: readonly BoardStreamEvent[]) =>
  events.filter((event) => event.type === "step").map((event) => event.raw);

describe("BoardLessonStreamParser", () => {
  it("手順を1つずつ、閉じた時点で出す", () => {
    const { events } = feedAll([lessonJson]);
    expect(events.map((event) => event.type)).toEqual(["lesson_head", "step", "step", "step"]);
    expect(stepsOf(events)).toEqual(lesson.steps);
  });

  /**
   * **これが案A(§3-2)の核心。**1文字ずつ流しても、手順が閉じた文字の回でだけ
   * 1つ出る。まとめて最後に出るなら、それは案B(全部生成してから再生)になっていて、
   * 低レイテンシという採用理由が消えている。
   */
  it("1文字ずつ流しても、閉じた回にだけ1つ出る(最後にまとめて出ない)", () => {
    const parts = slice(lessonJson, 1);
    const { perChunk, events } = feedAll(parts);

    // どのチャンクでも、出るのは高々1つ
    expect(Math.max(...perChunk.map((chunk) => chunk.length))).toBe(1);

    // 3手順のうち2つは、JSON全体を読み終える**前**に出ている
    const lastChunkIndex = parts.length - 1;
    const stepChunkIndexes = perChunk.flatMap((chunk, at) =>
      chunk.some((event) => event.type === "step") ? [at] : [],
    );
    expect(stepChunkIndexes).toHaveLength(3);
    for (const at of stepChunkIndexes.slice(0, 2)) expect(at).toBeLessThan(lastChunkIndex);

    // ヘッダは最初の手順より先に出る(board_open を先に送れる)
    const headIndex = perChunk.findIndex((chunk) =>
      chunk.some((event) => event.type === "lesson_head"),
    );
    expect(headIndex).toBeGreaterThanOrEqual(0);
    expect(headIndex).toBeLessThan(stepChunkIndexes[0] as number);

    expect(stepsOf(events)).toEqual(lesson.steps);
  });

  it("チャンクの切れ目がどこにあっても、同じ手順が同じ順で出る", () => {
    for (const size of [1, 2, 3, 5, 7, 13, 29, 64, 997]) {
      const { events, parser } = feedAll(slice(lessonJson, size));
      expect(stepsOf(events), `size=${size}`).toEqual(lesson.steps);
      expect(parser.completed, `size=${size}`).toBe(true);
    }
  });

  /**
   * 文字列の中・エスケープの中で切れるのは**普通に起きる**。
   * `tex` はバックスラッシュだらけなので、`\\frac` の `\` の直後で切れる回が必ず来る。
   */
  it("文字列の中・エスケープの中で切れても壊れない", () => {
    const withEscapes = JSON.stringify({
      title: 'D "判別式" を見る',
      topic_ids: ["M1-NIJI-HANBETSU"],
      steps: [
        {
          index: 0,
          speech: "ここ、分数のところ。",
          // JSONにすると "\\frac{-b \\pm \\sqrt{D}}{2a}" になり、
          // \\ の間で切れるチャンクが必ず現れる
          board: { kind: "latex", tex: "\\frac{-b \\pm \\sqrt{D}}{2a}" },
        },
        {
          index: 1,
          // 改行・タブ・引用符・Unicodeエスケープを1手順に全部入れる
          speech: '改行\nとタブ\tと "引用符" と − 記号',
          board: { kind: "text", body: "a = 1, b = -3, c = 2" },
        },
      ],
    });

    for (const size of [1, 2, 3, 4, 5, 8]) {
      const { events } = feedAll(slice(withEscapes, size));
      expect(stepsOf(events), `size=${size}`).toEqual(JSON.parse(withEscapes).steps);
    }
  });

  it("ヘッダの中身はそのまま渡す(検証はしない)", () => {
    const { events } = feedAll([lessonJson]);
    expect(events[0]).toEqual({
      type: "lesson_head",
      title: "判別式で解の個数を見る",
      topic_ids: ["M1-NIJI-HANBETSU"],
    });
  });

  // LLMは頼まなくてもフェンスを付けてくる(karte.ts の extractJson が同じ手当てをしている)
  it("前置きと ```json フェンスが付いていても読める", () => {
    const fenced = ["できました。", "```json", lessonJson, "```"].join("\n");
    const { events, parser } = feedAll(slice(fenced, 9));
    expect(stepsOf(events)).toEqual(lesson.steps);
    expect(parser.completed).toBe(true);
  });

  it("title と topic_ids が steps より後でも、揃った時点でヘッダが出る", () => {
    const reordered = `{"steps":${JSON.stringify(lesson.steps)},"title":"あとから見出し","topic_ids":["M1-NIJI-HANBETSU"]}`;
    const { events } = feedAll(slice(reordered, 11));

    expect(events.map((event) => event.type)).toEqual(["step", "step", "step", "lesson_head"]);
    expect(events.at(-1)).toEqual({
      type: "lesson_head",
      title: "あとから見出し",
      topic_ids: ["M1-NIJI-HANBETSU"],
    });
  });

  it("知らないキーが混ざっても手順の境界を見失わない", () => {
    const noisy = `{"note":{"why":"steps ではない入れ子"},"title":"見出し","topic_ids":["M1-NIJI-HANBETSU"],"steps":${JSON.stringify(lesson.steps)},"tokens":123}`;
    const { events, parser } = feedAll(slice(noisy, 6));
    expect(stepsOf(events)).toEqual(lesson.steps);
    expect(parser.completed).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* 壊れたときに、壊れたと分かること                                    */
  /* ------------------------------------------------------------------ */

  // 途中で切れた板書を「全部届いた」と扱うと、モバイルは末尾の欠落を検知できない。
  it("途中で切れたストリームは completed にならない", () => {
    const truncated = lessonJson.slice(0, lessonJson.length - 30);
    const { parser, events } = feedAll(slice(truncated, 17));

    expect(parser.completed).toBe(false);
    // 閉じたぶんは有効。ここまでは送ってよい。
    expect(stepsOf(events)).toEqual(lesson.steps.slice(0, 2));
  });

  it("閉じていない手順は出さない(値が揃って見えても)", () => {
    const parser = new BoardLessonStreamParser();
    const events = parser.feed(
      '{"title":"見出し","topic_ids":["M1-NIJI-HANBETSU"],"steps":[{"index":0,"speech":"まだ閉じていない","board":null',
    );
    expect(stepsOf(events)).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["lesson_head"]);
  });

  // 黙って読み飛ばすと、手順が1つ減ったまま板書が完成してしまう
  it("steps の要素がオブジェクトでなければ落ちる", () => {
    const parser = new BoardLessonStreamParser();
    expect(() =>
      parser.feed('{"title":"見出し","topic_ids":["M1-NIJI-HANBETSU"],"steps":["文字列"]}'),
    ).toThrow(BoardStreamError);
  });

  it("手順のJSONが壊れていれば落ちる", () => {
    const parser = new BoardLessonStreamParser();
    expect(() =>
      parser.feed('{"title":"見出し","topic_ids":["M1"],"steps":[{"index":0,,}]}'),
    ).toThrow(BoardStreamError);
  });

  // 閉じない文字列を掴んだまま「まだ来ていない」の顔で待ち続けない
  it("長すぎるストリームは打ち切る", () => {
    const parser = new BoardLessonStreamParser();
    expect(() => parser.feed(`{"title":"${"あ".repeat(boardStreamMaxLength)}`)).toThrow(
      /長すぎます/,
    );
  });

  it("ルートが閉じたあとの後始末(``` など)は読まない", () => {
    const parser = new BoardLessonStreamParser();
    parser.feed(lessonJson);
    expect(parser.feed('\n```\nおしまいです。{"steps":[{}]}')).toEqual([]);
    expect(parser.completed).toBe(true);
  });
});
