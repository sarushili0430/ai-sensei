import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type PlanSessionMetadata, type SessionMetadata, fixturePath } from "@ai-sensei/contract";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/**
 * The source of truth for API/agent boundary tests.
 * Hand-written valid JSON in every test can keep passing with stale fields after
 * a contract change, so build on the contract's fixture and override only the
 * differences that matter per test.
 */
export const sessionMetadataFixture = JSON.parse(
  readFileSync(resolve(repoRoot, fixturePath("session-metadata")), "utf8"),
) as SessionMetadata;

export function sessionMetadataJson(overrides: Partial<SessionMetadata> = {}): string {
  return JSON.stringify({ ...sessionMetadataFixture, ...overrides });
}

export const planSessionMetadataFixture = JSON.parse(
  readFileSync(resolve(repoRoot, fixturePath("plan-session-metadata")), "utf8"),
) as PlanSessionMetadata;

export function planSessionMetadataJson(overrides: Partial<PlanSessionMetadata> = {}): string {
  return JSON.stringify({ ...planSessionMetadataFixture, ...overrides });
}
