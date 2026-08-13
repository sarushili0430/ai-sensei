import { describe, expect, it } from "vitest";
import { jaSpeakable, ttsTextTransformsForLocale } from "./voice-session.ts";

function textStream(chunks: readonly string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readText(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

describe("jaSpeakable", () => {
  it("数式記号がチャンク境界をまたいでも一つの式として読む", async () => {
    await expect(readText(jaSpeakable(textStream(["∠", "ABC = 30", "°です。"])))).resolves.toBe(
      "かくエービーシー イコール さんじゅうどです。",
    );
  });
});

describe("ttsTextTransformsForLocale", () => {
  it("日本語だけに読み替えを追加し、既定の変換を保つ", () => {
    const transforms = ttsTextTransformsForLocale("ja");
    expect(transforms.slice(0, 2)).toEqual(["filter_markdown", "filter_emoji"]);
    expect(transforms).toHaveLength(3);
  });

  it("英語ロケールには日本語の読み替えを渡さない", () => {
    expect(ttsTextTransformsForLocale("en")).toEqual(["filter_markdown", "filter_emoji"]);
  });
});
