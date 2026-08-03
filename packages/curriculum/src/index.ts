import rawCurriculum from "../data/curriculum.v0.json" with { type: "json" };
import {
  type CourseName,
  type Curriculum,
  type Topic,
  courseCodeByName,
  curriculumSchema,
  topicIdPattern,
} from "./schema.ts";

export * from "./schema.ts";

/**
 * カリキュラムマップ本体。
 * ここが「高校数学の範囲」の正であり、後輩AIが触れてよい話題の全集合。
 */
export const curriculum: Curriculum = curriculumSchema.parse(rawCurriculum);

export const topics: readonly Topic[] = curriculum.topics;

const topicById = new Map<string, Topic>(topics.map((topic) => [topic.id, topic]));

/** ガードレール照合用のID集合。 */
export const topicIds: ReadonlySet<string> = new Set(topicById.keys());

export function findTopic(id: string): Topic | undefined {
  return topicById.get(id);
}

/** LLMが返したtopic_idがカリキュラム内かを判定する(サーバ側ガードの一次判定)。 */
export function isKnownTopicId(id: string): boolean {
  return topicById.has(id);
}

export function topicsByCourse(course: CourseName): Topic[] {
  return topics.filter((topic) => topic.course === course);
}

export function topicsByUnit(course: CourseName, unit: string): Topic[] {
  return topics.filter((topic) => topic.course === course && topic.unit === unit);
}

/**
 * 前提トピックを再帰的にたどる。穴の深掘り(「そもそも◯◯とは?」)で、
 * 1つ手前の単元まで質問を落とすのに使う。
 * @param depth たどる段数。1なら直接の前提のみ。
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

/**
 * 写真解析で得たテキスト(単元名・用語・式の断片)から候補トピックを引く。
 *
 * スコアの重みは トピック名(5) > 単元名(3) > キーワード(2)。
 * 一致は部分一致だが、`sin` `tan` `log` のようなラテン文字の短い語は
 * **語境界でのみ**照合する(`constant` の中の `tan` を三角比と見なさないため)。
 *
 * ここで拾った候補が、後輩AIに渡す「触れてよい話題」の初期集合になる。
 */
export function suggestTopics(text: string, limit = 5): Topic[] {
  const haystack = normalizeForMatch(text);
  if (haystack.length === 0) return [];

  // 負数や小数を渡されても、slice(0, limit) の妙な挙動に落ちないようにする
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return [];

  const scored = topics
    .map((topic) => ({ topic, score: scoreTopic(topic, haystack) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));

  return scored.slice(0, take).map((entry) => entry.topic);
}

function scoreTopic(topic: Topic, haystack: string): number {
  let score = 0;
  if (matches(haystack, topic.unit)) score += 3;
  if (matches(haystack, topic.topic)) score += 5;
  for (const keyword of topic.keywords) {
    // 1文字キーワードは事故のもとなので数えない
    if (keyword.length >= 2 && matches(haystack, keyword)) score += 2;
  }
  return score;
}

/** ラテン文字だけで書かれた語(sin / tan / log / x など)。 */
const LATIN_ONLY = /^[a-z0-9^/+*=<>().-]+$/;

function matches(haystack: string, needle: string): boolean {
  const normalized = normalizeForMatch(needle);
  if (normalized.length === 0) return false;

  // 日本語の語はそのまま部分一致でよい(「判別式」が別語に埋もれることはない)。
  if (!LATIN_ONLY.test(normalized)) return haystack.includes(normalized);

  // ラテン文字の語は前後を語境界に限る。`constant` の `tan`、`since` の `sin`、
  // `biology` の `log` を数学の証拠と見なすと、数学以外の写真が範囲を通ってしまう。
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "u").test(haystack);
}

function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

export type IntegrityIssue = {
  kind:
    | "duplicate-id"
    | "unknown-prerequisite"
    | "self-prerequisite"
    | "id-course-mismatch"
    | "cycle";
  topicId: string;
  detail: string;
};

/**
 * スキーマでは表せない整合性(参照の妥当性・循環・IDとコースの一致)を検査する。
 * トピックを手で足していくのでCIで毎回回す。
 */
export function checkIntegrity(data: Curriculum = curriculum): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const seen = new Set<string>();
  const index = new Map<string, Topic>();

  for (const topic of data.topics) {
    if (seen.has(topic.id)) {
      issues.push({ kind: "duplicate-id", topicId: topic.id, detail: "IDが重複しています" });
    }
    seen.add(topic.id);
    index.set(topic.id, topic);

    const expectedPrefix = courseCodeByName[topic.course];
    if (!topic.id.startsWith(`${expectedPrefix}-`)) {
      issues.push({
        kind: "id-course-mismatch",
        topicId: topic.id,
        detail: `course=${topic.course} なら接頭辞は ${expectedPrefix}- のはずです`,
      });
    }
  }

  for (const topic of data.topics) {
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

/** topic_idの形だけを検査する(未知IDかどうかは isKnownTopicId で見る)。 */
export function isWellFormedTopicId(id: string): boolean {
  return topicIdPattern.test(id);
}
