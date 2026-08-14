import { zodToJsonSchema } from "zod-to-json-schema";
import { type FixtureName, fixtureSchemas } from "./fixtures.ts";

/**
 * Generates JSON Schema from the zod schemas.
 *
 * zod is authoritative on the TypeScript side. The Dart (freezed) side is written
 * by hand, so the JSON Schema is committed to the repo as something whose diffs
 * can be followed by eye. `src/json-schema.test.ts` checks the output has not
 * drifted from what is committed.
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
