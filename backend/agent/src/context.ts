import {
  type PlanSessionMetadata,
  type SessionMetadata,
  planSessionMetadataSchema,
  sessionMetadataSchema,
} from "@ai-sensei/contract";
import { type CurriculumSubject, subjectOfTopicId } from "@ai-sensei/curriculum";
import { formatBullets } from "@ai-sensei/prompts";

/**
 * Conversation context that backend/api put in the LiveKit token metadata.
 *
 * The photo interpretation and the topics that may be touched live here.
 * Passing them on a separate channel could produce a session whose token and
 * context disagree, so they ride the same path as the token.
 *
 * Defining the shape only on the receiving side would let renames and new
 * required fields hide behind defaults, so validation uses the shared contract
 * itself and agent-specific shaping happens only after validation.
 */
export const sessionContextSchema = sessionMetadataSchema;

export type SessionContext = SessionMetadata;
export type PlanSessionContext = PlanSessionMetadata;
export type AgentContext = SessionContext | PlanSessionContext;

export class InvalidSessionContextError extends Error {}

/**
 * The subject of this lesson. Decides what the board may use and which audio
 * hints are bundled.
 *
 * There is no subject field in metadata; it is derived from the `allowed_topic_ids`
 * prefix (ADR 0007 - curriculum, language, subject and school stage all follow
 * from a single topic_id). No extra contract, so API and agent deploy order does
 * not matter.
 *
 * {@link readSessionContext} rejects sessions with no allowed topics, so a first
 * element always exists. If it still cannot be derived, fall back to math - the
 * behaviour from when math was the only subject, so nothing gets worse.
 */
export function subjectOf(context: Pick<SessionContext, "allowed_topic_ids">): CurriculumSubject {
  const [first] = context.allowed_topic_ids;
  return (first ? subjectOfTopicId(first) : undefined) ?? "math";
}

/**
 * Read participant metadata.
 * Never start the conversation if this fails: without context the senpai teaches
 * generalities unrelated to the photo.
 */
export function readSessionContext(metadata: string | undefined | null): SessionContext {
  if (!metadata) {
    throw new InvalidSessionContextError("参加者のmetadataが空です");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(metadata);
  } catch {
    throw new InvalidSessionContextError("参加者のmetadataがJSONではありません");
  }

  const parsed = sessionContextSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidSessionContextError(`metadataの形式が不正です: ${parsed.error.message}`);
  }
  if (parsed.data.allowed_topic_ids.length === 0) {
    throw new InvalidSessionContextError("許可トピックが空のセッションは開始できません");
  }
  return withLocalePlaceholders(parsed.data);
}

/**
 * Fill blanks with "none" *in the conversation's language*.
 *
 * Only `question_seeds` is left. The contract guarantees `.min(1)` for
 * `problem_text` and `visible_work` and supplies their placeholders, so we do
 * not touch them (two fill sites means drifting wording).
 *
 * `question_seeds` is a required field, but the contract allows an empty string,
 * so it is tidied here after validation. An empty section makes the model read it
 * as "unreadable" and start guessing about the photo.
 * `formatBullets([])` is borrowed to keep the wording in one place - backend/api
 * builds it with the same function, so it cannot drift unless a different string
 * is written here.
 */
function withLocalePlaceholders(context: SessionContext): SessionContext {
  if (context.question_seeds.trim() !== "") return context;
  return { ...context, question_seeds: formatBullets([], context.locale) };
}

/**
 * Context arrives on two paths. Use whichever reads first.
 *
 * - participant metadata (the token's `metadata` claim)
 * - job metadata (`roomConfig.agents[].metadata`, on explicit dispatch)
 *
 * The API puts the same content on both, but which one arrives depends on
 * whether the worker is named. Reading only one drops to "context unreadable,
 * hang up quietly" the moment dispatch style changes.
 */
export function resolveSessionContext(
  candidates: readonly (string | undefined | null)[],
): SessionContext {
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return readSessionContext(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new InvalidSessionContextError(
    errors.length > 0 ? errors.join(" / ") : "セッション文脈がどこにも載っていません",
  );
}

/**
 * Tell the lesson and plan envelopes apart, then read.
 *
 * Widening `sessionKinds` into a union on the lesson schema would make the
 * problem text - required for a lesson - optional too. Only the entrance is a
 * union; after discrimination each strict schema applies, so adding planning
 * cannot reopen the "teach without seeing the problem" path.
 */
export function readAgentContext(metadata: string | undefined | null): AgentContext {
  if (!metadata) throw new InvalidSessionContextError("参加者のmetadataが空です");
  let raw: unknown;
  try {
    raw = JSON.parse(metadata);
  } catch {
    throw new InvalidSessionContextError("参加者のmetadataがJSONではありません");
  }

  if (isPlanEnvelope(raw)) {
    const parsed = planSessionMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidSessionContextError(`計画metadataの形式が不正です: ${parsed.error.message}`);
    }
    return parsed.data;
  }
  return readSessionContext(metadata);
}

export function resolveAgentContext(
  candidates: readonly (string | undefined | null)[],
): AgentContext {
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return readAgentContext(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new InvalidSessionContextError(
    errors.length > 0 ? errors.join(" / ") : "セッション文脈がどこにも載っていません",
  );
}

function isPlanEnvelope(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "plan";
}

/** Seconds left in the conversation. Passed to the prompt to decide when to wrap up. */
export function remainingSeconds(
  context: Pick<AgentContext, "max_seconds">,
  startedAt: Date,
  now: Date,
): number {
  const elapsed = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
  return Math.max(0, context.max_seconds - elapsed);
}
