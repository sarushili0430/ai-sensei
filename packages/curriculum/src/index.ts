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
 * カリキュラムマップ本体。**課程(track)ごとに1本**。
 *
 * ここが「触れてよい話題」の正。日本の高校生には数学I〜Cを、海外の学習者には
 * Algebra 1 〜 Calculus / Statistics を出す(翻訳ではなく別のマップ)。
 *
 * `Record<TrackId, Curriculum>` なので、`trackIds` に id を足してデータを
 * 忘れると**型で落ちる**。課程が増えるときの取りこぼしはここで止まる。
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

/** 既知の指導言語か。未知の値はここで `ja` に丸める(既定は日本語で教える)。 */
export function toCurriculumLocale(value: string | undefined | null): CurriculumLocale {
  return curriculumLocales.find((locale) => locale === value) ?? "ja";
}

/**
 * 全課程のトピック。
 *
 * topic_id は接頭辞で課程が分かれているので衝突しない。ID照合(ガードレール)は
 * どの課程で始まったセッションでも同じ関数で通せる。
 * **画面やプロンプトに一覧を出すときは {@link topicsForTracks} で課程を絞ること。**
 */
export const topics: readonly Topic[] = trackIds.flatMap((track) => curricula[track].topics);

/**
 * 指定した課程のトピックだけを返す。
 *
 * **引数は課程の配列**で、指導言語ではない。「中学生に見せる一覧」は
 * *中学数学 + 中学英語* の2課程で、言語で絞ると4課程ぶん(約185件)が
 * 無言でプロンプトに載る。{@link tracksForStage} と組で使うこと。
 */
export function topicsForTracks(trackList: readonly TrackId[]): readonly Topic[] {
  const wanted = new Set(trackList);
  return trackIds.filter((track) => wanted.has(track)).flatMap((track) => curricula[track].topics);
}

/**
 * その段階の生徒に見せてよい課程。
 *
 * 海外課程は段階で分かれていない(Algebra 1 〜 Calculus が一続き)ので、
 * `locale: "en"` はどちらの段階でも同じ1本を返す。
 */
export function tracksForStage(stage: SchoolStage, locale: CurriculumLocale): TrackId[] {
  return trackIds.filter((track) => {
    const definition = tracks[track];
    if (definition.locale !== locale) return false;
    return definition.locale === "en" || definition.stage === stage;
  });
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
 * topic_id が属する課程。
 *
 * 穴(hole)にはtopic_idが必ず付いていて、そのカルテの文言も同じ課程の言語で
 * 書かれている。**通知や復習画面の言語も、板書に使える要素も、ここから決まる**ので、
 * セッションの課程をDBに持たなくても、あとから取り違えない(ADR 0005 / 0006)。
 */
export function trackOfTopicId(id: string): TrackId | undefined {
  const code = id.slice(0, id.indexOf("-"));
  return trackByCourseCode[code as keyof typeof trackByCourseCode];
}

/**
 * topic_id が属する課程の**指導言語**。
 *
 * 教える中身の言語ではない。日本の中学生が英語を学ぶ課程は `"ja"` を返す —
 * 先輩は日本語で話し、通知も日本語で届く。
 */
export function localeOfTopicId(id: string): CurriculumLocale | undefined {
  const track = trackOfTopicId(id);
  return track && tracks[track].locale;
}

/** topic_id が属する課程の教科。板書に使える要素と音声補正ヒントを決める。 */
export function subjectOfTopicId(id: string): CurriculumSubject | undefined {
  const track = trackOfTopicId(id);
  return track && tracks[track].subject;
}

/** topic_id が属する課程の学校段階。 */
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
 * チップや計画画面に出す短いラベル。「中1」「数学I」「英コミュI」。
 *
 * **`grade_hint` を読むのはここだけ。** 学年で範囲を絞る口はどこにも無く、
 * この関数が表示専用であることが「学年は目安」という約束の実体になっている
 * (詳細は `topicSchema.grade_hint` のコメント)。
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
  /** 絞り込む課程。省略すると全課程から探す。 */
  tracks?: readonly TrackId[];
};

/**
 * 写真解析で得たテキスト(単元名・用語・式の断片)から候補トピックを引く。
 *
 * スコアの重みは トピック名(5) > 単元名(3) > キーワード(2)。
 * 一致は部分一致だが、`sin` `tan` `log` `law of sines` のようなラテン文字の語は
 * **語境界でのみ**照合する(`constant` の中の `tan` を三角比と見なさないため)。
 *
 * ここで拾った候補が、後輩AIに渡す「触れてよい話題」の初期集合になる。
 * **学年で絞る引数は無い。** 中学英語の学年配当は教科書ごとに違うので、
 * 学年を条件にすると別の教科書を使っている生徒の単元が消える。
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
 * スキーマでは表せない整合性(参照の妥当性・循環・IDとコースの一致)を検査する。
 * トピックを手で足していくのでCIで毎回回す。
 *
 * 引数なしで呼ぶと**全課程のカリキュラム**をまとめて検査する。
 * IDは課程をまたいで一意でなければならず、前提の参照は
 * **同じ指導言語・同じ教科の中**に閉じている必要がある(Algebra 2 の前提が
 * 数学II になっていると、英語のセッションで日本語のトピックが混ざる)。
 *
 * 段(中学 → 高校)はまたいでよい。高校英語の前提は中学英語、高校数学の前提は
 * 中学数学であるのが自然で、「二次方程式で詰まっている高2を中3へ戻す」は
 * 先輩の中核機能そのものだから。
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

    // 空振りの着地点が、その課程に実在しないと着地できない
    if (set.fallback_topic_id && !set.topics.some((t) => t.id === set.fallback_topic_id)) {
      issues.push({
        kind: "unknown-fallback-topic",
        topicId: set.fallback_topic_id,
        detail: `fallback_topic_id が ${set.track} のトピックにありません`,
      });
    }

    // 宣言だけして中身が無いコースは、一覧に出た瞬間「選べるのに何も無い」になる
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

/** topic_idの形だけを検査する(未知IDかどうかは isKnownTopicId で見る)。 */
export function isWellFormedTopicId(id: string): boolean {
  return topicIdPattern.test(id);
}
