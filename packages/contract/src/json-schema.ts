import { zodToJsonSchema } from "zod-to-json-schema";
import { type FixtureName, fixtureSchemas } from "./fixtures.ts";

/**
 * zodスキーマからJSON Schemaを起こす。
 *
 * TypeScript側の正はzod。Dart(freezed)側は手書きになるため、
 * 差分を目で追える形として JSON Schema をリポジトリにコミットしておく。
 * 生成物がコミット済みのものとずれていないかは `src/json-schema.test.ts` が見る。
 */
export function buildJsonSchema(name: FixtureName): Record<string, unknown> {
  return zodToJsonSchema(fixtureSchemas[name], {
    name,
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function serializeJsonSchema(name: FixtureName): string {
  return `${JSON.stringify(buildJsonSchema(name), null, 2)}\n`;
}
