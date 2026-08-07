import rawIntlCurriculum from "../data/curriculum.intl.v0.json" with { type: "json" };
import rawJaCurriculum from "../data/curriculum.v0.json" with { type: "json" };
import {
  type CourseName,
  type Curriculum,
  type CurriculumLocale,
  type Topic,
  courseCodeByName,
  courseNamesByLocale,
  curriculumLocales,
  curriculumSchema,
  localeByCourseCode,
  topicIdPattern,
} from "./schema.ts";

export * from "./schema.ts";

/**
 * カリキュラムマップ本体。**ロケールごとに1本**。
 *
 * ここが「触れてよい話題」の正。日本の高校生には数学I〜Cを、海外の学習者には
 * Algebra 1 〜 Calculus / Statistics を出す(翻訳ではなく別のマップ)。
 */
export const curricula: Record<CurriculumLocale, Curriculum> = {
  ja: curriculumSchema.parse(rawJaCurriculum),
  en: curriculumSchema.parse(rawIntlCurriculum),
};

export function curriculumFor(locale: CurriculumLocale): Curriculum {
  return curricula[locale];
}

/** 既知のロケールか。未知の値はここで `ja` に丸める(既定は日本の課程)。 */
export function toCurriculumLocale(value: string | undefined | null): CurriculumLocale {
  return curriculumLocales.find((locale) => locale === value) ?? "ja";
}

/**
 * 全ロケールのトピック。
 *
 * topic_id は接頭辞でロケールが分かれているので衝突しない。ID照合
 * (ガードレール)はどちらの課程で始まったセッションでも同じ関数で通せる。
 * **画面やプロンプトに一覧を出すときは {@link topicsFor} でロケールを絞ること。**
 */
export const topics: readonly Topic[] = curriculumLocales.flatMap(
  (locale) => curricula[locale].topics,
);

export function topicsFor(locale: CurriculumLocale): readonly Topic[] {
  return curricula[locale].topics;
}

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

/**
 * topic_id が属する課程のロケール。
 *
 * 穴(hole)にはtopic_idが必ず付いていて、そのカルテの文言も同じ課程の言語で
 * 書かれている。**通知や復習画面の言語はここから決める**ので、セッションの
 * ロケールをDBに持たなくても、あとから言語を取り違えない。
 */
export function localeOfTopicId(id: string): CurriculumLocale | undefined {
  const code = id.slice(0, id.indexOf("-"));
  return localeByCourseCode[code as keyof typeof localeByCourseCode];
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

export type SuggestTopicsOptions = {
  /** 絞り込む課程。省略すると全ロケールから探す。 */
  locale?: CurriculumLocale;
};

/**
 * 写真解析で得たテキスト(単元名・用語・式の断片)から候補トピックを引く。
 *
 * スコアの重みは トピック名(5) > 単元名(3) > キーワード(2)。
 * 一致は部分一致だが、`sin` `tan` `log` `law of sines` のようなラテン文字の語は
 * **語境界でのみ**照合する(`constant` の中の `tan` を三角比と見なさないため)。
 *
 * ここで拾った候補が、後輩AIに渡す「触れてよい話題」の初期集合になる。
 */
export function suggestTopics(
  text: string,
  limit = 5,
  options: SuggestTopicsOptions = {},
): Topic[] {
  const haystack = buildHaystack(text);
  if (haystack.compact.length === 0) return [];

  // 負数や小数を渡されても、slice(0, limit) の妙な挙動に落ちないようにする
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return [];

  const pool = options.locale ? topicsFor(options.locale) : topics;
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
    // 1文字キーワードは事故のもとなので数えない
    if (keyword.length >= 2 && matches(haystack, keyword)) score += 2;
  }
  return score;
}

/** ラテン文字だけで書かれた語(sin / tan / log / law of sines / b^2-4ac など)。 */
const LATIN_ONLY = /^[a-z0-9^/+*=<>().'’ -]+$/;

/**
 * 照合用に2つの形を持つ。
 *
 * - `compact`: 空白を全部落としたもの。日本語は分かち書きされないので、
 *   OCRが入れた空白(「円 と 直線」)を無視して部分一致できる。
 * - `spaced`: 空白を1つに畳んだもの。英語は**語の区切りが空白**なので、
 *   落としてしまうと `law of sines` が `usingthelawofsines` の中で
 *   語境界を失い、二度と一致しなくなる。
 */
type Haystack = { compact: string; spaced: string };

function buildHaystack(value: string): Haystack {
  const spaced = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return { compact: spaced.replace(/\s+/gu, ""), spaced };
}

function matches(haystack: Haystack, needle: string): boolean {
  const { compact, spaced } = buildHaystack(needle);
  if (compact.length === 0) return false;

  // 日本語の語はそのまま部分一致でよい(「判別式」が別語に埋もれることはない)。
  if (!LATIN_ONLY.test(spaced)) return haystack.compact.includes(compact);

  // ラテン文字の語は前後を語境界に限る。`constant` の `tan`、`since` の `sin`、
  // `biology` の `log` を数学の証拠と見なすと、数学以外の写真が範囲を通ってしまう。
  const escaped = spaced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "u").test(haystack.spaced);
}

export type IntegrityIssue = {
  kind:
    | "duplicate-id"
    | "unknown-prerequisite"
    | "self-prerequisite"
    | "id-course-mismatch"
    | "course-locale-mismatch"
    | "cross-curriculum-prerequisite"
    | "cycle";
  topicId: string;
  detail: string;
};

/**
 * スキーマでは表せない整合性(参照の妥当性・循環・IDとコースの一致)を検査する。
 * トピックを手で足していくのでCIで毎回回す。
 *
 * 引数なしで呼ぶと**全ロケールのカリキュラム**をまとめて検査する。
 * IDはロケールをまたいで一意でなければならず、前提の参照は課程内に閉じている
 * 必要がある(Algebra 2 の前提が 数学II になっていると、英語のセッションで
 * 日本語のトピックが混ざる)。
 */
export function checkIntegrity(
  data: Curriculum | readonly Curriculum[] = curriculumLocales.map((locale) => curricula[locale]),
): IntegrityIssue[] {
  const sets = Array.isArray(data) ? (data as readonly Curriculum[]) : [data as Curriculum];
  const issues: IntegrityIssue[] = [];
  const seen = new Set<string>();
  const index = new Map<string, Topic>();
  const localeByTopicId = new Map<string, CurriculumLocale>();

  for (const set of sets) {
    const allowedCourses = new Set(courseNamesByLocale[set.locale]);
    for (const topic of set.topics) {
      if (seen.has(topic.id)) {
        issues.push({ kind: "duplicate-id", topicId: topic.id, detail: "IDが重複しています" });
      }
      seen.add(topic.id);
      index.set(topic.id, topic);
      localeByTopicId.set(topic.id, set.locale);

      const expectedPrefix = courseCodeByName[topic.course];
      if (!topic.id.startsWith(`${expectedPrefix}-`)) {
        issues.push({
          kind: "id-course-mismatch",
          topicId: topic.id,
          detail: `course=${topic.course} なら接頭辞は ${expectedPrefix}- のはずです`,
        });
      }
      if (!allowedCourses.has(topic.course)) {
        issues.push({
          kind: "course-locale-mismatch",
          topicId: topic.id,
          detail: `locale=${set.locale} のカリキュラムに course=${topic.course} は入りません`,
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
      if (localeByTopicId.get(prerequisiteId) !== localeByTopicId.get(topic.id)) {
        issues.push({
          kind: "cross-curriculum-prerequisite",
          topicId: topic.id,
          detail: `別の課程のトピックを前提にしています: ${prerequisiteId}`,
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
