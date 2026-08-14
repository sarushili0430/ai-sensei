import { describe, expect, it } from "vitest";
import {
  BoardLessonStreamParser,
  BoardStreamError,
  type BoardStreamEvent,
  boardStreamMaxLength,
} from "./board-stream.ts";

/**
 * Tests for incremental parsing. Not "can it read" but "does exactly one step
 * come out the moment it closes" and "is a break visible when it breaks".
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

/** Cut chunks mechanically (boundary positions must carry no meaning). */
function slice(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts;
}

/** Feed one chunk at a time and return what came out on each. */
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
   * This is the heart of option A (§3-2). Fed one character at a time, exactly
   * one step comes out on the character that closes it. Everything arriving at
   * the end would mean option B (generate fully, then play), losing the low
   * latency that motivated the choice.
   */
  it("1文字ずつ流しても、閉じた回にだけ1つ出る(最後にまとめて出ない)", () => {
    const parts = slice(lessonJson, 1);
    const { perChunk, events } = feedAll(parts);

    // At most one comes out on any chunk
    expect(Math.max(...perChunk.map((chunk) => chunk.length))).toBe(1);

    // Two of the three steps come out *before* the whole JSON is read
    const lastChunkIndex = parts.length - 1;
    const stepChunkIndexes = perChunk.flatMap((chunk, at) =>
      chunk.some((event) => event.type === "step") ? [at] : [],
    );
    expect(stepChunkIndexes).toHaveLength(3);
    for (const at of stepChunkIndexes.slice(0, 2)) expect(at).toBeLessThan(lastChunkIndex);

    // The header precedes the first step (so board_open can go first)
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
   * Cutting inside a string or an escape happens routinely.
   * `tex` is full of backslashes, so some chunk always ends right after the `\`
   * of `\\frac`.
   */
  it("文字列の中・エスケープの中で切れても壊れない", () => {
    const withEscapes = JSON.stringify({
      title: 'D "判別式" を見る',
      topic_ids: ["M1-NIJI-HANBETSU"],
      steps: [
        {
          index: 0,
          speech: "ここ、分数のところ。",
          // As JSON this is "\\frac{-b \\pm \\sqrt{D}}{2a}", so a chunk boundary
          // inevitably falls between the two backslashes
          board: { kind: "latex", tex: "\\frac{-b \\pm \\sqrt{D}}{2a}" },
        },
        {
          index: 1,
          // Newline, tab, quotes and a Unicode escape, all in one step
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

  // The LLM adds fences unasked (karte.ts's extractJson handles the same case)
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
  /* Breaking visibly when it breaks                                    */
  /* ------------------------------------------------------------------ */

  // Treating a truncated board as "fully delivered" hides the missing tail from mobile.
  it("途中で切れたストリームは completed にならない", () => {
    const truncated = lessonJson.slice(0, lessonJson.length - 30);
    const { parser, events } = feedAll(slice(truncated, 17));

    expect(parser.completed).toBe(false);
    // What closed is valid and may be sent
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

  // Skipping silently would complete the board with one step missing
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

  // Never hold an unclosed string while pretending it just has not arrived yet
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
