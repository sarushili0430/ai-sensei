import {
  type CurriculumLocale,
  type Topic,
  findTopic,
  isKnownTopicId,
  isWellFormedTopicId,
  localeOfTopicId,
  prerequisitesOf,
} from "@ai-sensei/curriculum";

/**
 * Matches karte topic_ids against the set of units a session may cover.
 *
 * Units detected from the photo, plus their prerequisites, become the allow-list
 * passed to the senpai's prompt. After the karte is generated, the topic_ids on the
 * holes are matched mechanically against that range.
 */

export type AllowedTopics = {
  /** Units detected from the photo. The lesson's subject. */
  primary: ReadonlySet<string>;
  /** Prerequisite topics. How far back the senpai may go to teach the cause of the block. */
  prerequisite: ReadonlySet<string>;
};

/**
 * How many prerequisite levels one session follows. The same number the prompt
 * promises the senpai.
 *
 * `prompts/senpai_board.{ja,en}.md` says the allow-list contains "today's subject
 * plus two levels of its prerequisites". The senpai goes back to prerequisites so
 * it can teach "from the discriminant, if the discriminant did not come out", so
 * being able to go back is the heart of lesson mode (without it, a stuck student
 * cannot be taken anywhere).
 *
 * Until 2026-08-10 the default here was 1. The prompt described two levels, but
 * `backend/api` called it with the default, so second-level prerequisites never
 * entered the allow-list and were never offered to the senpai as "units you may
 * choose". Board delivery's `validateStep()` validates a step's schema and its
 * LaTeX; it does not match topic_ids against the allow-set. Nothing was being
 * rejected by the old question guard. The default was fixed rather than adding
 * `{ prerequisiteDepth: 2 }` at the call site, because the drift was exactly the
 * shape of "the caller forgot the option" - with a wrong default, the next caller
 * added would reintroduce the same drift.
 *
 * Why it stops at two (measured on the real curricula, 2026-08-10):
 * an allow-set built from 1-2 detected units is about 2.0-3.4 entries at depth 1,
 * about 2.9-4.8 at depth 2 and about 3.4-5.8 at depth 3. The longest prerequisite
 * chain is only five levels, and depth 3 onward barely adds anything. As a list
 * pasted into the prompt, two levels also stays within 10 entries.
 *
 * Prerequisite edges extend along the learning order, so going deeper never reaches
 * unrelated units (vectors never enter a trigonometry allow-list).
 *
 * Karte generation and the transcript side pass `{ prerequisiteDepth: 0 }`
 * explicitly for a different reason - they want to count "what the conversation
 * actually touched". Changing this does not affect them.
 */
export const conversationPrerequisiteDepth = 2;

export type BuildAllowedTopicsOptions = {
  /**
   * How many prerequisite levels to follow. 0 forbids going deeper.
   * Defaults to {@link conversationPrerequisiteDepth} (the number the prompt promises).
   */
  prerequisiteDepth?: number;
};

/**
 * Builds the set of topics the senpai may touch, starting from the topic_ids
 * detected in the photo. Unknown ids are dropped silently (the caller decides on
 * re-analysis when it sees an empty set).
 */
export function buildAllowedTopics(
  detectedTopicIds: readonly string[],
  options: BuildAllowedTopicsOptions = {},
): AllowedTopics {
  const depth = options.prerequisiteDepth ?? conversationPrerequisiteDepth;
  const primary = new Set<string>();
  for (const id of detectedTopicIds) {
    if (isKnownTopicId(id)) primary.add(id);
  }

  const prerequisite = new Set<string>();
  if (depth > 0) {
    for (const id of primary) {
      for (const topic of prerequisitesOf(id, depth)) {
        if (!primary.has(topic.id)) prerequisite.add(topic.id);
      }
    }
  }

  return { primary, prerequisite };
}

export function isAllowedTopic(allowed: AllowedTopics, topicId: string): boolean {
  return allowed.primary.has(topicId) || allowed.prerequisite.has(topicId);
}

export function allowedTopicList(allowed: AllowedTopics): Topic[] {
  return [...allowed.primary, ...allowed.prerequisite]
    .map((id) => findTopic(id))
    .filter((topic): topic is Topic => topic !== undefined);
}

/**
 * Which curriculum this allow-list belongs to.
 *
 * It follows from the topic_id prefix, so the conversation's language is determined
 * from the allowed units without carrying the session's locale around separately.
 */
export function allowedTopicsLocale(allowed: AllowedTopics): CurriculumLocale {
  for (const id of allowed.primary) {
    const locale = localeOfTopicId(id);
    if (locale) return locale;
  }
  for (const id of allowed.prerequisite) {
    const locale = localeOfTopicId(id);
    if (locale) return locale;
  }
  return "ja";
}

export const rejectionReasons = [
  /** The topic_id's shape is broken. */
  "malformed_topic_id",
  /** Well-formed but absent from the curriculum map (university maths, another subject, ...). */
  "unknown_topic_id",
  /** In the curriculum, but not in this session's allow-list. */
  "topic_not_allowed",
] as const;
export type RejectionReason = (typeof rejectionReasons)[number];

/**
 * Checks the topic_ids attached to a karte's holes.
 * Tags that went outside the range allowed during the conversation make review
 * notifications off-target too.
 */
export function filterHoleTopicIds<T extends { topic_id: string }>(
  holes: readonly T[],
  allowed: AllowedTopics,
): { accepted: T[]; rejected: { hole: T; reason: RejectionReason }[] } {
  const accepted: T[] = [];
  const rejected: { hole: T; reason: RejectionReason }[] = [];
  for (const hole of holes) {
    if (!isWellFormedTopicId(hole.topic_id)) {
      rejected.push({ hole, reason: "malformed_topic_id" });
    } else if (!isKnownTopicId(hole.topic_id)) {
      rejected.push({ hole, reason: "unknown_topic_id" });
    } else if (!isAllowedTopic(allowed, hole.topic_id)) {
      rejected.push({ hole, reason: "topic_not_allowed" });
    } else {
      accepted.push(hole);
    }
  }
  return { accepted, rejected };
}
