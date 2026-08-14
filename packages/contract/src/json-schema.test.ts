import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureNames } from "./fixtures.ts";
import { buildJsonSchema, serializeJsonSchema } from "./json-schema.ts";

const schemaDir = resolve(import.meta.dirname, "..", "schema");

describe("JSON Schemaの生成物", () => {
  // Change zod and forget to regenerate the JSON Schema, and the Dart side is implemented against a stale definition.
  it.each(fixtureNames)("schema/%s.json が最新である", (name) => {
    const committed = readFileSync(resolve(schemaDir, `${name}.json`), "utf8");
    expect(committed, "pnpm --filter @ai-sensei/contract generate:schema を実行してください").toBe(
      serializeJsonSchema(name),
    );
  });
});

/**
 * `schema/*.json` is the reference for Dart implementation - the only definition
 * whoever writes the Flutter side reads. zod's `.refine()` leaves nothing in JSON
 * Schema, so a meaningful guard written with refine disappears from the reference.
 * Anything expressible as a single regex is written with `.regex()`, and this pins
 * that it survives in the reference as a pattern.
 *
 * Things a regex cannot express (sequential numbering, min<max, ...) are listed in
 * the README's "invariants absent from JSON Schema".
 */
describe("板書のガードがDartの参照に残っている", () => {
  // biome-ignore lint/suspicious/noExplicitAny: a test that only walks the generated JSON Schema
  const definition = buildJsonSchema("board-lesson")["definitions"] as any;
  const step = definition["board-lesson"].properties.steps.items;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  const elementOf = (kind: string): any =>
    // biome-ignore lint/suspicious/noExplicitAny: as above
    step.properties.board.anyOf[0].anyOf.find((e: any) => e.properties.kind.const === kind);

  it.each([
    ["speech(LaTeXを喋らせない)", () => step.properties.speech],
    ["tex(多行環境の禁止)", () => elementOf("latex").properties.tex],
    ["fn(端末で評価する式の文字種)", () => elementOf("plot").properties.fn],
    // biome-ignore lint/suspicious/noExplicitAny: as above
  ])("%s が pattern として出力されている", (_name, pick: () => any) => {
    expect(pick().pattern).toBeTypeOf("string");
  });

  it("三角形の頂点とラベルの個数が minItems/maxItems として出力されている", () => {
    const triangle = elementOf("triangle");
    expect(triangle.properties.vertices).toMatchObject({ minItems: 3, maxItems: 3 });
    expect(triangle.properties.labels).toMatchObject({ minItems: 3, maxItems: 3 });
  });
});

/**
 * A study plan's date is a calendar day, not an instant (`planDateSchema` in
 * `plan.ts`). If the `pattern` drops out of the reference, the Dart side
 * implements it as "a date-ish string" and accepts ISO8601 instants - and from
 * there the test moves a day earlier by the timezone offset.
 */
describe("学習計画の日付がDartの参照に残っている", () => {
  // biome-ignore lint/suspicious/noExplicitAny: a test that only walks the generated JSON Schema
  const plan = buildJsonSchema("study-plan")["definitions"] as any;
  const properties = plan["study-plan"].properties;

  it.each([
    ["テスト日", () => properties.intake.properties.exam_date],
    ["割り当ての日", () => properties.days.items.properties.date],
    // biome-ignore lint/suspicious/noExplicitAny: as above
  ])("%s が pattern として出力されている", (_name, pick: () => any) => {
    expect(pick().pattern).toBe("^\\d{4}-\\d{2}-\\d{2}$");
  });
});
