/**
 * 開発サーバが**配ってよいものだけを配る**か。
 *
 * 見た目の道具にテストは要らないが、ここは配信の境界で、
 * 壊れても画面には何も出ない(黙ってリポジトリのファイルが読めるだけ)。
 */
import { describe, expect, it } from "vitest";
import { promptBody, promptStatus, resolveFile } from "../serve.ts";

describe("resolveFile", () => {
  it("public/ の中を配る", () => {
    expect(resolveFile("/index.html")).toMatch(/apps\/tuner\/public\/index\.html$/);
    expect(resolveFile("/")).toMatch(/apps\/tuner\/public\/index\.html$/);
  });

  it("ディレクトリを指されたら中の index.html を出す(/debug も /debug/ も同じ)", () => {
    expect(resolveFile("/debug")).toMatch(/public\/debug\/index\.html$/);
    expect(resolveFile("/debug/")).toMatch(/public\/debug\/index\.html$/);
  });

  it("vendor は node_modules へ橋渡しする", () => {
    expect(resolveFile("/vendor/katex/katex.mjs")).toMatch(
      /node_modules\/katex\/dist\/katex\.mjs$/,
    );
  });

  it("public/ の外へは出られない(エンコードした .. も含めて)", () => {
    expect(resolveFile("/../package.json")).toBeNull();
    expect(resolveFile("/%2e%2e/package.json")).toBeNull();
    expect(resolveFile("/vendor/katex/../../../../package.json")).toBeNull();
  });

  it("無いものは null(500ではなく404にするため)", () => {
    expect(resolveFile("/nope.js")).toBeNull();
  });
});

describe("promptBody", () => {
  it("一覧にあるプロンプトだけを、フロントマターと本文に分けて返す", async () => {
    const { prompts } = await promptStatus();
    const first = prompts[0];
    if (!first) throw new Error("prompts/*.md が1つも無い");

    const prompt = await promptBody(first.file);
    expect(prompt?.file).toBe(first.file);
    expect(prompt?.body.length).toBeGreaterThan(0);
    // 本文にフロントマターの区切りを持ち越さない(そのまま画面に出すため)。
    expect(prompt?.body.startsWith("---")).toBe(false);
  });

  it("一覧に無い名前は読まない(prompts/ の外を読む口を作らない)", async () => {
    expect(await promptBody("../package.json")).toBeNull();
    expect(await promptBody("README.md")).toBeNull();
    expect(await promptBody("")).toBeNull();
  });
});
