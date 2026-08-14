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
  startSessionResponseSchema,
} from "./api.ts";
import { boardChannelLogSchema, boardLessonSchema } from "./board.ts";
import { karteSchema } from "./karte.ts";
import { parentReportResponseSchema } from "./parent-report.ts";
import { planTurnSchema, studyPlanSchema } from "./plan.ts";

/**
 * The fixture name -> schema table.
 *
 * Parsing the same fixture in both Flutter (freezed) and TypeScript (zod) lets CI
 * detect "contract drift" when only one side's schema changed.
 * The fixtures themselves live in packages/contract/fixtures/*.json.
 */
export const fixtureSchemas = {
  "create-session-request": createSessionRequestSchema,
  "create-session-response": createSessionResponseSchema,
  // The room key rides only on this one. Keeping it a separate fixture from the
  // photo-reading response (create-session-response) is itself the shape of
  // "uses are counted at conversation start".
  "start-session-response": startSessionResponseSchema,
  "complete-session-request": completeSessionRequestSchema,
  "complete-session-response": completeSessionResponseSchema,
  // The conversation context that reaches the agent on the LiveKit token. Not an
  // HTTP body, so it is absent from the endpoint table - yet it is the
  // backend/api <-> agent contract itself.
  "session-metadata": sessionMetadataSchema,
  karte: karteSchema,
  "review-queue-response": reviewQueueResponseSchema,
  "progress-response": progressResponseSchema,
  "api-error": apiErrorSchema,
  // The board. What the LLM emits (board-lesson) and what flows on the data
  // channel (board-channel-log) have different responsibilities, so they are
  // separate fixtures (reasoning at the top of src/board.ts).
  "board-lesson": boardLessonSchema,
  "board-channel-log": boardChannelLogSchema,
  // Study plans. As with the board, what the LLM emits (study-plan-turn) is kept
  // separate from the stored shape. The screen and parent report read the stored
  // one; the agent validates LLM output against the turn (a plan is born during
  // the interview, so the LLM's unit is one turn, not one plan).
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

/** The unit a JSON Schema is generated from. One file per schema. */
export const fixtureNames = Object.keys(fixtureSchemas) as FixtureName[];

/**
 * Fixture file -> the schema it must satisfy.
 *
 * One schema can have several files. `*.en.json` is the overseas-curriculum shape
 * (Algebra 1 / Algebra 2 ...), whose topic_id prefixes and subject names differ
 * from the Japanese curricula. That both pass the same schema is pinned in
 * TypeScript and Dart alike.
 */
export const fixtureFileSchemas: Record<string, FixtureName> = {
  ...Object.fromEntries(fixtureNames.map((name) => [name, name])),
  "create-session-response.en": "create-session-response",
  "karte.en": "karte",
  "board-lesson.en": "board-lesson",
  // An English-curriculum board. Its usable elements do not overlap maths (sentence / compare).
  "board-lesson.english": "board-lesson",
  "study-plan.en": "study-plan",
  "parent-report.en": "parent-report",
};

export const fixtureFileNames = Object.keys(fixtureFileSchemas);

/** The fixture file's repo-relative path. Dart tests use the same convention. */
export function fixturePath(name: string): string {
  return `packages/contract/fixtures/${name}.json`;
}
