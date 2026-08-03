/**
 * zodスキーマ → packages/contract/schema/*.json を再生成する。
 *
 *   pnpm --filter @ai-sensei/contract generate:schema
 *
 * 生成物はコミットする。ずれているとテストが落ちる。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureNames } from "./fixtures.ts";
import { serializeJsonSchema } from "./json-schema.ts";

const outDir = resolve(import.meta.dirname, "..", "schema");
mkdirSync(outDir, { recursive: true });

for (const name of fixtureNames) {
  writeFileSync(resolve(outDir, `${name}.json`), serializeJsonSchema(name), "utf8");
  console.log(`generated schema/${name}.json`);
}
