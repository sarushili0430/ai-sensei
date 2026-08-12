import type { ZodTypeAny } from "zod";
import {
  apiErrorSchema,
  completePlanSessionRequestSchema,
  completePlanSessionResponseSchema,
  completeSessionRequestSchema,
  completeSessionResponseSchema,
  createPlanSessionRequestSchema,
  createPlanSessionResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  planResponseSchema,
  planSessionMetadataSchema,
  progressResponseSchema,
  reviewQueueResponseSchema,
  sessionMetadataSchema,
} from "./api.ts";
import { boardChannelLogSchema, boardLessonSchema } from "./board.ts";
import { karteSchema } from "./karte.ts";
import { parentReportResponseSchema } from "./parent-report.ts";
import { planTurnSchema, studyPlanSchema } from "./plan.ts";

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
  // LiveKitトークンに載って agent に届く会話文脈。HTTPのボディではないので
  // 「主なエンドポイント」の表には出てこないが、backend/api ↔ agent の契約そのもの。
  "session-metadata": sessionMetadataSchema,
  karte: karteSchema,
  "review-queue-response": reviewQueueResponseSchema,
  "progress-response": progressResponseSchema,
  "api-error": apiErrorSchema,
  // 板書。LLMが出す形(board-lesson)と、data channel を流れる形(board-channel-log)は
  // 責務が違うので別のfixtureにしている(理由は src/board.ts の冒頭)。
  "board-lesson": boardLessonSchema,
  "board-channel-log": boardChannelLogSchema,
  // 学習計画。板書と同じく、LLMが出す形(study-plan-turn)と保存後の形を分けている。
  // 画面と親レポートが読むのは保存後のほう、agentがLLM出力を検証するのは turn のほう
  // (計画は聞き取りの会話の途中で生まれるので、LLMの単位は「計画」ではなく「1ターン」)。
  "study-plan": studyPlanSchema,
  "study-plan-turn": planTurnSchema,
  "parent-report": parentReportResponseSchema,
  "create-plan-session-request": createPlanSessionRequestSchema,
  "create-plan-session-response": createPlanSessionResponseSchema,
  "plan-session-metadata": planSessionMetadataSchema,
  "complete-plan-session-request": completePlanSessionRequestSchema,
  "complete-plan-session-response": completePlanSessionResponseSchema,
  "plan-response": planResponseSchema,
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
  "board-lesson.en": "board-lesson",
  // 英語の課程の板書。数学とは使える要素が重ならない(sentence / compare)。
  "board-lesson.english": "board-lesson",
  "study-plan.en": "study-plan",
  "parent-report.en": "parent-report",
};

export const fixtureFileNames = Object.keys(fixtureFileSchemas);

/** fixtureファイルのリポジトリ相対パス。Dart側のテストからも同じ規約で参照する。 */
export function fixturePath(name: string): string {
  return `packages/contract/fixtures/${name}.json`;
}
