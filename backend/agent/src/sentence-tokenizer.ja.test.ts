import { describe, expect, it } from "vitest";
import { JapaneseSentenceTokenizer, splitJapaneseSentences } from "./sentence-tokenizer.ja.ts";

describe("JapaneseSentenceTokenizer", () => {
  it("日本語の全角・半角の文末記号で切り、閉じ引用符を前の文に残す", () => {
    const sentences = splitJapaneseSentences("最初です。次です？最後です！英語も終わり.");
    expect(sentences).toEqual([
      ["最初です。", 0, 5],
      ["次です？", 5, 9],
      ["最後です！", 9, 14],
      ["英語も終わり.", 14, 21],
    ]);
    expect(new JapaneseSentenceTokenizer().tokenize("そうだよ。」次です。 ")).toEqual([
      "そうだよ。」",
      "次です。",
    ]);
  });

  it("英語混じりの文も元の文字のまま返す", () => {
    expect(new JapaneseSentenceTokenizer().tokenize("x は 3 です。That's it.")).toEqual([
      "x は 3 です。",
      "That's it.",
    ]);
  });

  it("読点は長い節だけで切る", () => {
    expect(
      new JapaneseSentenceTokenizer().tokenize(
        "これは十分に長い説明をゆっくり続けている文章なので、" + "ここで読点でも区切ります。",
      ),
    ).toEqual([
      "これは十分に長い説明をゆっくり続けている文章なので、",
      "ここで読点でも区切ります。",
    ]);
  });

  it("空白・空文字・記号だけを安全に扱う", () => {
    const tokenizer = new JapaneseSentenceTokenizer();

    expect(tokenizer.tokenize("")).toEqual([]);
    expect(tokenizer.tokenize("  \n\t ")).toEqual([]);
    expect(tokenizer.tokenize("。！？")).toEqual(["。！？"]);
  });

  it("LLMの生成完了を待たず、次の文が届いた時点で最初の文を出す", async () => {
    const stream = new JapaneseSentenceTokenizer().stream();
    const firstToken = stream.next();

    stream.pushText("最初に大切な点を");
    stream.pushText("説明します。次の");

    await expect(firstToken).resolves.toMatchObject({
      value: { token: "最初に大切な点を説明します。" },
    });
    stream.close();
  });

  it("flushで未完の最後の文を取りこぼさない", async () => {
    const stream = new JapaneseSentenceTokenizer().stream();

    stream.pushText("最初に大切な点を説明します。最後の一文です");
    await expect(stream.next()).resolves.toMatchObject({
      value: { token: "最初に大切な点を説明します。" },
    });

    stream.flush();
    await expect(stream.next()).resolves.toMatchObject({
      value: { token: "最後の一文です" },
    });
    stream.close();
  });
});
