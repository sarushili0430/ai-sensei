import type { ZodTypeAny } from "zod";
import {
  completeSessionRequestSchema,
  completeSessionResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  progressResponseSchema,
  reviewQueueResponseSchema,
  apiErrorSchema,
} from "./api.ts";
import { karteSchema } from "./karte.ts";

/**
 * fixture名 → スキーマの対応表。
 *
 * 同じfixtureを Flutter(freezed) と TypeScript(zod) の両方でパースすることで、
 * 片側だけスキーマを変えた「契約ドリフト」をCIで検知する。
 * fixtureの実体は packages/contract/fixtures/*.json。
 */
export const fixtureSchemas = {
  "create-session-request": createSessionRequestSchema,
  "create-session-response": createSessionResponseSchema,
  "complete-session-request": completeSessionRequestSchema,
  "complete-session-response": completeSessionResponseSchema,
  "karte": karteSchema,
  "review-queue-response": reviewQueueResponseSchema,
  "progress-response": progressResponseSchema,
  "api-error": apiErrorSchema,
} satisfies Record<string, ZodTypeAny>;

export type FixtureName = keyof typeof fixtureSchemas;

export const fixtureNames = Object.keys(fixtureSchemas) as FixtureName[];

/** fixtureファイルのリポジトリ相対パス。Dart側のテストからも同じ規約で参照する。 */
export function fixturePath(name: FixtureName): string {
  return `packages/contract/fixtures/${name}.json`;
}
