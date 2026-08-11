import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type PlanSessionMetadata, type SessionMetadata, fixturePath } from "@ai-sensei/contract";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/**
 * APIとagentの境界テストに使う正本。
 * 手書きの有効JSONを各テストに持つと契約変更後も旧フィールドのまま通りうるため、
 * contractのfixtureを土台にし、各テストで意味のある差分だけを上書きする。
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
