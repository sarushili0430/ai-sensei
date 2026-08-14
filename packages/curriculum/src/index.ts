import rawHsEnglishCurriculum from "../data/curriculum.hs-english.v0.json" with { type: "json" };
import rawIntlCurriculum from "../data/curriculum.intl.v0.json" with { type: "json" };
import rawJhsEnglishCurriculum from "../data/curriculum.jhs-english.v0.json" with { type: "json" };
import rawJhsMathCurriculum from "../data/curriculum.jhs-math.v0.json" with { type: "json" };
import rawJaCurriculum from "../data/curriculum.v0.json" with { type: "json" };
import {
  type CourseName,
  type Curriculum,
  type CurriculumLocale,
  type CurriculumSubject,
  type SchoolStage,
  type Topic,
  type TrackId,
  courseCodeByName,
  courseNamesByTrack,
  curriculumLocales,
  curriculumSchema,
  topicIdPattern,
  trackByCourseCode,
  trackIds,
  tracks,
} from "./schema.ts";

export * from "./schema.ts";

/**
 * The curriculum map itself. One per curriculum (track).
 *
 * This is authoritative for "topics that may be touched". Japanese high-schoolers
 * get Math I-C, overseas learners get Algebra 1 through Calculus / Statistics
 * (a separate map, not a translation).
 *
 * Being a `Record<TrackId, Curriculum>`, adding an id to `trackIds` and forgetting
 * the data fails type checking. Omissions when adding a curriculum stop here.
 */
export const curricula: Record<TrackId, Curriculum> = {
  hs_math_ja: curriculumSchema.parse(rawJaCurriculum),
  hs_math_en: curriculumSchema.parse(rawIntlCurriculum),
  jhs_math_ja: curriculumSchema.parse(rawJhsMathCurriculum),
  jhs_english_ja: curriculumSchema.parse(rawJhsEnglishCurriculum),
  hs_english_ja: curriculumSchema.parse(rawHsEnglishCurriculum),
};

export function curriculumFor(track: TrackId): Curriculum {
  return curricula[track];
}

/** Whether the language of instruction is known. Unknown values round to `ja` (teach in Japanese by default). */
export function toCurriculumLocale(value: string | undefined | null): CurriculumLocale {
  return curriculumLocales.find((locale) => locale === value) ?? "ja";
}

/**
 * Topics from every curriculum.
 *
 * topic_ids are separated by prefix per curriculum, so they never collide. Id
 * matching (the guardrails) can use the same function whichever curriculum a
 * session started in.
 * When listing them on a screen or in a prompt, narrow by curriculum with
 * {@link topicsForTracks}.
 */
export const topics: readonly Topic[] = trackIds.flatMap((track) => curricula[track].topics);

/**
 * Returns only the topics of the given curricula.
 *
 * The argument is an array of curricula, not a language of instruction. The list
 * shown to a middle-schooler is two curricula - middle-school maths plus
 * middle-school English - and narrowing by language would silently put four
 * curricula (about 185 entries) into the prompt. Use it together with
 * {@link tracksForStage}.
 */
export function topicsForTracks(trackList: readonly TrackId[]): readonly Topic[] {
  const wanted = new Set(trackList);
  return trackIds.filter((track) => wanted.has(track)).flatMap((track) => curricula[track].topics);
}

/**
 * The curricula that may be shown to a student at that stage.
 *
 * The overseas curricula are not split by stage (Algebra 1 through Calculus is one
 * continuum), so `locale: "en"` returns the same single track for either stage.
 */
export function tracksForStage(stage: SchoolStage, locale: CurriculumLocale): TrackId[] {
  return trackIds.filter((track) => {
    const definition = tracks[track];
    if (definition.locale !== locale) return false;
    return definition.locale === "en" || definition.stage === stage;
  });
}

const topicById = new Map<string, Topic>(topics.map((topic) => [topic.id, topic]));

/** The id set used for guardrail matching. */
export const topicIds: ReadonlySet<string> = new Set(topicById.keys());

export function findTopic(id: string): Topic | undefined {
  return topicById.get(id);
}

/** Whether a topic_id returned by the LLM is in the curriculum (the server guard's first check). */
export function isKnownTopicId(id: string): boolean {
  return topicById.has(id);
}

/**
 * The curriculum a topic_id belongs to.
 *
 * Every hole carries a topic_id, and its karte's wording is written in the same
 * curriculum's language. The language of notifications and the review screen, and
 * which board elements are usable, all follow from here - so the session's
 * curriculum need not be stored in the DB and can never be confused later
 * (ADR 0005 / 0006).
 */
export function trackOfTopicId(id: string): TrackId | undefined {
  const code = id.slice(0, id.indexOf("-"));
  return trackByCourseCode[code as keyof typeof trackByCourseCode];
}

/**
 * The language of *instruction* for the curriculum a topic_id belongs to.
 *
 * Not the language of what is taught. A curriculum where Japanese
 * middle-schoolers learn English returns `"ja"` - the senpai speaks Japanese and
 * notifications arrive in Japanese.
 */
export function localeOfTopicId(id: string): CurriculumLocale | undefined {
  const track = trackOfTopicId(id);
  return track && tracks[track].locale;
}

/** The subject of the curriculum a topic_id belongs to. Decides usable board elements and speech hints. */
export function subjectOfTopicId(id: string): CurriculumSubject | undefined {
  const track = trackOfTopicId(id);
  return track && tracks[track].subject;
}

/** The school stage of the curriculum a topic_id belongs to. */
export function stageOfTopicId(id: string): SchoolStage | undefined {
  const track = trackOfTopicId(id);
  return track && tracks[track].stage;
}

const shortByCourseName = new Map<string, string>(
  trackIds.flatMap((track) =>
    curricula[track].courses.map((course) => [course.name, course.short] as const),
  ),
);

/**
 * The short label shown on chips and the plan screen: "Grade 7", "Math I", "EC I".
 *
 * This is the only place `grade_hint` is read. There is no entry point anywhere
 * that narrows scope by grade, and this function being display-only is what makes
 * the promise "the grade is only a rough guide" real (details in
 * `topicSchema.grade_hint`'s comment).
 */
export function topicLabel(topic: Topic): string {
  if (topic.grade_hint !== undefined) return `中${topic.grade_hint}`;
  return shortByCourseName.get(topic.course) ?? topic.course;
}

export function topicsByCourse(course: CourseName): Topic[] {
  return topics.filter((topic) => topic.course === course);
}

export function topicsByUnit(course: CourseName, unit: string): Topic[] {
  return topics.filter((topic) => topic.course === course && topic.unit === unit);
}

/**
 * Walks prerequisite topics recursively. Used when digging into a hole ("what is X
 * in the first place?") to drop the question back one unit.
 * @param depth how many levels to follow. 1 means direct prerequisites only.
 */
export function prerequisitesOf(id: string, depth = 1): Topic[] {
  const collected = new Map<string, Topic>();
  let frontier = [id];

  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const currentId of frontier) {
      const topic = topicById.get(currentId);
      if (!topic) continue;
      for (const prerequisiteId of topic.prerequisites) {
        if (collected.has(prerequisiteId) || prerequisiteId === id) continue;
        const prerequisite = topicById.get(prerequisiteId);
        if (!prerequisite) continue;
        collected.set(prerequisiteId, prerequisite);
        next.push(prerequisiteId);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return [...collected.values()];
}

export type SuggestTopicsOptions = {
  /** Which curricula to narrow to. Omitted, it searches all of them. */
  tracks?: readonly TrackId[];
};

/**
 * Finds candidate topics from the text obtained by photo analysis (unit names,
 * terms, formula fragments).
 *
 * Score weights are topic name (5) > unit name (3) > keyword (2). Matching is by
 * substring, but Latin-script words such as `sin`, `tan`, `log` and `law of sines`
 * match only at word boundaries (so the `tan` inside `constant` is not read as
 * trigonometry).
 *
 * The candidates found here become the initial set of "topics that may be touched"
 * handed to the AI. There is no parameter for narrowing by grade: middle-school
 * English grade allocation differs per textbook, so conditioning on grade would
 * erase units for students using another textbook.
 */
export function suggestTopics(
  text: string,
  limit = 5,
  options: SuggestTopicsOptions = {},
): Topic[] {
  const haystack = buildHaystack(text);
  if (haystack.compact.length === 0) return [];

  // Guard against negative or fractional input falling into slice(0, limit)'s odd behaviour
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return [];

  const pool = options.tracks ? topicsForTracks(options.tracks) : topics;
  const scored = pool
    .map((topic) => ({ topic, score: scoreTopic(topic, haystack) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));

  return scored.slice(0, take).map((entry) => entry.topic);
}

function scoreTopic(topic: Topic, haystack: Haystack): number {
  let score = 0;
  if (matches(haystack, topic.unit)) score += 3;
  if (matches(haystack, topic.topic)) score += 5;
  for (const keyword of topic.keywords) {
    // Single-character keywords cause accidents, so they are not counted
    if (keyword.length >= 2 && matches(haystack, keyword)) score += 2;
  }
  return score;
}

/** A word written only in Latin script (sin / tan / log / law of sines / b^2-4ac ...). */
const LATIN_ONLY = /^[a-z0-9^/+*=<>().'’ -]+$/;

/**
 * Two forms are kept for matching.
 *
 * - `compact`: all whitespace removed. Japanese is not word-spaced, so this ignores
 *   spaces the OCR inserted ("円 と 直線") and still matches by substring.
 * - `spaced`: whitespace collapsed to one. English separates words with spaces, so
 *   removing them would lose `law of sines`'s word boundaries inside
 *   `usingthelawofsines` and it would never match again.
 */
type Haystack = { compact: string; spaced: string };

function buildHaystack(value: string): Haystack {
  const spaced = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return { compact: spaced.replace(/\s+/gu, ""), spaced };
}

function matches(haystack: Haystack, needle: string): boolean {
  const { compact, spaced } = buildHaystack(needle);
  if (compact.length === 0) return false;

  // Japanese words are fine as plain substring matches ("判別式" never hides inside another word).
  if (!LATIN_ONLY.test(spaced)) return haystack.compact.includes(compact);

  // Latin-script words are bounded on both sides. Reading the `tan` in `constant`,
  // the `sin` in `since` or the `log` in `biology` as evidence of maths would let
  // non-maths photos through the scope check.
  const escaped = spaced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "u").test(haystack.spaced);
}

export type IntegrityIssue = {
  kind:
    | "duplicate-id"
    | "unknown-prerequisite"
    | "self-prerequisite"
    | "id-course-mismatch"
    | "id-track-mismatch"
    | "course-track-mismatch"
    | "cross-curriculum-prerequisite"
    | "grade-hint-not-allowed"
    | "empty-course"
    | "unknown-fallback-topic"
    | "cycle";
  topicId: string;
  detail: string;
};

/**
 * Checks the consistency the schema cannot express (reference validity, cycles,
 * agreement between id and course). Topics are added by hand, so this runs on every
 * CI job.
 *
 * Called with no arguments it checks every curriculum together. Ids must be unique
 * across curricula, and prerequisite references must stay within the same language
 * of instruction and the same subject (an Algebra 2 prerequisite pointing at Math II
 * would mix a Japanese topic into an English session).
 *
 * Crossing stages (middle -> high school) is allowed. High-school English naturally
 * has middle-school English as a prerequisite, and high-school maths middle-school
 * maths - "take a year-11 student stuck on quadratics back to year 9" is the
 * senpai's core function.
 */
export function checkIntegrity(
  data: Curriculum | readonly Curriculum[] = trackIds.map((track) => curricula[track]),
): IntegrityIssue[] {
  const sets = Array.isArray(data) ? (data as readonly Curriculum[]) : [data as Curriculum];
  const issues: IntegrityIssue[] = [];
  const seen = new Set<string>();
  const index = new Map<string, Topic>();
  const trackByTopicId = new Map<string, TrackId>();

  for (const set of sets) {
    const allowedCourses = new Set(courseNamesByTrack[set.track]);
    const usedCourses = new Set<string>();

    for (const topic of set.topics) {
      if (seen.has(topic.id)) {
        issues.push({ kind: "duplicate-id", topicId: topic.id, detail: "IDが重複しています" });
      }
      seen.add(topic.id);
      index.set(topic.id, topic);
      trackByTopicId.set(topic.id, set.track);
      usedCourses.add(topic.course);

      const expectedPrefix = courseCodeByName[topic.course];
      if (!topic.id.startsWith(`${expectedPrefix}-`)) {
        issues.push({
          kind: "id-course-mismatch",
          topicId: topic.id,
          detail: `course=${topic.course} なら接頭辞は ${expectedPrefix}- のはずです`,
        });
      }
      if (trackOfTopicId(topic.id) !== set.track) {
        issues.push({
          kind: "id-track-mismatch",
          topicId: topic.id,
          detail: `接頭辞の課程が ${set.track} と違います`,
        });
      }
      if (!allowedCourses.has(topic.course)) {
        issues.push({
          kind: "course-track-mismatch",
          topicId: topic.id,
          detail: `track=${set.track} のカリキュラムに course=${topic.course} は入りません`,
        });
      }
      if (topic.grade_hint !== undefined && tracks[set.track].subject !== "english") {
        issues.push({
          kind: "grade-hint-not-allowed",
          topicId: topic.id,
          detail:
            "grade_hint は学年配当が教科書ごとに違う英語の課程にだけ書けます(数学は course が学年を持つ)",
        });
      }
    }

    // A landing point for missed inference cannot land if it does not exist in that curriculum
    if (set.fallback_topic_id && !set.topics.some((t) => t.id === set.fallback_topic_id)) {
      issues.push({
        kind: "unknown-fallback-topic",
        topicId: set.fallback_topic_id,
        detail: `fallback_topic_id が ${set.track} のトピックにありません`,
      });
    }

    // A course declared with no content becomes "selectable but empty" the moment it appears in a list
    for (const course of set.courses) {
      if (!usedCourses.has(course.name)) {
        issues.push({
          kind: "empty-course",
          topicId: `${set.track}:${course.code}`,
          detail: `course=${course.name} を宣言していますが、トピックが1件もありません`,
        });
      }
    }
  }

  for (const topic of index.values()) {
    for (const prerequisiteId of topic.prerequisites) {
      if (prerequisiteId === topic.id) {
        issues.push({
          kind: "self-prerequisite",
          topicId: topic.id,
          detail: "自分自身を前提にしています",
        });
        continue;
      }
      if (!index.has(prerequisiteId)) {
        issues.push({
          kind: "unknown-prerequisite",
          topicId: topic.id,
          detail: `未定義のトピックを前提にしています: ${prerequisiteId}`,
        });
        continue;
      }
      const here = trackByTopicId.get(topic.id);
      const there = trackByTopicId.get(prerequisiteId);
      if (!here || !there) continue;
      if (
        tracks[here].locale !== tracks[there].locale ||
        tracks[here].subject !== tracks[there].subject
      ) {
        issues.push({
          kind: "cross-curriculum-prerequisite",
          topicId: topic.id,
          detail: `別の言語または別の教科のトピックを前提にしています: ${prerequisiteId}`,
        });
      }
    }
  }

  for (const topicId of findCycles(index)) {
    issues.push({ kind: "cycle", topicId, detail: "前提関係が循環しています" });
  }

  return issues;
}

function findCycles(index: Map<string, Topic>): string[] {
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      cycles.push(id);
      return;
    }
    state.set(id, "visiting");
    for (const prerequisiteId of index.get(id)?.prerequisites ?? []) {
      if (index.has(prerequisiteId)) visit(prerequisiteId);
    }
    state.set(id, "done");
  };

  for (const id of index.keys()) visit(id);
  return cycles;
}

/** Checks only a topic_id's shape (use isKnownTopicId for whether it is known). */
export function isWellFormedTopicId(id: string): boolean {
  return topicIdPattern.test(id);
}
