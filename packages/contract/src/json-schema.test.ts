import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureNames } from "./fixtures.ts";
import { serializeJsonSchema } from "./json-schema.ts";

const schemaDir = resolve(import.meta.dirname, "..", "schema");

describe("JSON Schemaの生成物", () => {
  // zodを変えてJSON Schemaの再生成を忘れると、Dart側が古い定義のまま実装される。
  it.each(fixtureNames)("schema/%s.json が最新である", (name) => {
    const committed = readFileSync(resolve(schemaDir, `${name}.json`), "utf8");
    expect(committed, "npm run -w @ai-sensei/contract generate:schema を実行してください").toBe(
      serializeJsonSchema(name),
    );
  });
});
