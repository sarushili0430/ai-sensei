import type { ZodTypeAny } from "zod";
import {
  apiErrorSchema,
  completeSessionRequestSchema,
  completeSessionResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  progressResponseSchema,
  reviewQueueResponseSchema,
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
  karte: karteSchema,
  "review-queue-response": reviewQueueResponseSchema,
  "progress-response": progressResponseSchema,
  "api-error": apiErrorSchema,
} satisfies Record<string, ZodTypeAny>;

export type FixtureName = keyof typeof fixtureSchemas;

/** JSON Schema を起こす単位。スキーマ1つにつき1ファイル。 */
export const fixtureNames = Object.keys(fixtureSchemas) as FixtureName[];

/**
 * fixtureファイル → 満たすべきスキーマ。
 *
 * スキーマ1つに対してファイルは複数ありうる。`*.en.json` は**海外向けの課程**
 * (Algebra 1 / Algebra 2 ...)のかたちで、topic_idの接頭辞も科目名も日本の
 * 課程とは別。同じスキーマで両方が通ることを、TypeScriptとDartの双方で固定する。
 */
export const fixtureFileSchemas: Record<string, FixtureName> = {
  ...Object.fromEntries(fixtureNames.map((name) => [name, name])),
  "create-session-response.en": "create-session-response",
  "karte.en": "karte",
};

export const fixtureFileNames = Object.keys(fixtureFileSchemas);

/** fixtureファイルのリポジトリ相対パス。Dart側のテストからも同じ規約で参照する。 */
export function fixturePath(name: string): string {
  return `packages/contract/fixtures/${name}.json`;
}
