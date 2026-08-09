import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureNames } from "./fixtures.ts";
import { buildJsonSchema, serializeJsonSchema } from "./json-schema.ts";

const schemaDir = resolve(import.meta.dirname, "..", "schema");

describe("JSON Schemaの生成物", () => {
  // zodを変えてJSON Schemaの再生成を忘れると、Dart側が古い定義のまま実装される。
  it.each(fixtureNames)("schema/%s.json が最新である", (name) => {
    const committed = readFileSync(resolve(schemaDir, `${name}.json`), "utf8");
    expect(committed, "pnpm --filter @ai-sensei/contract generate:schema を実行してください").toBe(
      serializeJsonSchema(name),
    );
  });
});

/**
 * `schema/*.json` は「Dart実装時の参照用」で、Flutter側を書く人が読む唯一の定義。
 * zodの `.refine()` はJSON Schemaに **何も残さない** ので、意味のあるガードをrefineで書くと
 * 参照から消える。単一の正規表現で書けるものは `.regex()` で書き、
 * 「参照に pattern として残っていること」をここで固定する。
 *
 * 正規表現では表現できないもの(連番・min<max など)は
 * README「JSON Schema に現れない不変条件」に一覧がある。
 */
describe("板書のガードがDartの参照に残っている", () => {
  // biome-ignore lint/suspicious/noExplicitAny: 生成物(JSON Schema)を辿るだけのテスト
  const definition = buildJsonSchema("board-lesson")["definitions"] as any;
  const step = definition["board-lesson"].properties.steps.items;
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  const elementOf = (kind: string): any =>
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    step.properties.board.anyOf[0].anyOf.find((e: any) => e.properties.kind.const === kind);

  it.each([
    ["speech(LaTeXを喋らせない)", () => step.properties.speech],
    ["tex(多行環境の禁止)", () => elementOf("latex").properties.tex],
    ["fn(端末で評価する式の文字種)", () => elementOf("plot").properties.fn],
    // biome-ignore lint/suspicious/noExplicitAny: 同上
  ])("%s が pattern として出力されている", (_name, pick: () => any) => {
    expect(pick().pattern).toBeTypeOf("string");
  });

  it("三角形の頂点とラベルの個数が minItems/maxItems として出力されている", () => {
    const triangle = elementOf("triangle");
    expect(triangle.properties.vertices).toMatchObject({ minItems: 3, maxItems: 3 });
    expect(triangle.properties.labels).toMatchObject({ minItems: 3, maxItems: 3 });
  });
});
