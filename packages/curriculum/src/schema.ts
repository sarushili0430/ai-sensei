import { z } from "zod";

/**
 * The language of instruction: what the senpai speaks, and the guardrails' vocabulary.
 *
 * Which curriculum it is is not decided here ({@link TrackId}'s job). In ADR 0005
 * this value doubled as the curriculum, but that cannot express "a Japanese
 * middle-schooler learning English" = curriculum English / instruction Japanese, so
 * the curriculum was split out into {@link CurriculumTrack} (ADR 0007).
 * Never add a value like `"ja-english"` to this type - `Record<CurriculumLocale, ...>`
 * appears throughout the prompts and guardrails, and everywhere it means "one per
 * language".
 */
export const curriculumLocales = ["ja", "en"] as const;
export type CurriculumLocale = (typeof curriculumLocales)[number];
export const curriculumLocaleSchema = z.enum(curriculumLocales);

/**
 * The school stage. Used to narrow which curricula get pasted into a prompt.
 *
 * Pasting every curriculum leaves both photo analysis and the plan interview
 * running with room to "recommend Math II to a middle-schooler". Halving by stage
 * removes that room structurally.
 */
export const schoolStages = ["junior_high", "high_school"] as const;
export type SchoolStage = (typeof schoolStages)[number];
export const schoolStageSchema = z.enum(schoolStages);

/**
 * The subject. The axis that branches which board elements are usable and which
 * speech-correction hints are bundled.
 *
 * A maths board uses formulas (latex/plot/triangle/circle) and an English board
 * uses example sentences and comparison tables; the usable sets do not overlap.
 * The same goes for speech correction: applying "さんぶんのに = 2/3" to English
 * speech judges a student stuck when they said it correctly.
 */
export const curriculumSubjects = ["math", "english"] as const;
export type CurriculumSubject = (typeof curriculumSubjects)[number];
export const curriculumSubjectSchema = z.enum(curriculumSubjects);

/**
 * The curriculum. One track = one JSON file, and this is the unit that separates
 * "topics that may be touched".
 *
 * To add a curriculum: add the id here, add its definition to `tracks`, add its
 * prefix to `trackByCourseCode`, then add the data file. Since `curricula` is a
 * `Record<TrackId, Curriculum>`, adding only the id and forgetting the data fails
 * type checking.
 */
export const trackIds = [
  "hs_math_ja",
  "hs_math_en",
  "jhs_math_ja",
  "jhs_english_ja",
  "hs_english_ja",
] as const;
export type TrackId = (typeof trackIds)[number];
export const trackIdSchema = z.enum(trackIds);

export type CurriculumTrack = {
  id: TrackId;
  /** The language the senpai speaks. Not the language of what is taught. */
  locale: CurriculumLocale;
  subject: CurriculumSubject;
  stage: SchoolStage;
};

export const tracks: Record<TrackId, CurriculumTrack> = {
  hs_math_ja: { id: "hs_math_ja", locale: "ja", subject: "math", stage: "high_school" },
  hs_math_en: { id: "hs_math_en", locale: "en", subject: "math", stage: "high_school" },
  jhs_math_ja: { id: "jhs_math_ja", locale: "ja", subject: "math", stage: "junior_high" },
  // English as learned by Japanese middle-schoolers. The language of instruction is
  // Japanese (the senpai speaks Japanese).
  jhs_english_ja: {
    id: "jhs_english_ja",
    locale: "ja",
    subject: "english",
    stage: "junior_high",
  },
  hs_english_ja: {
    id: "hs_english_ja",
    locale: "ja",
    subject: "english",
    stage: "high_school",
  },
};

/** Japanese high-school maths (the six courses of the current guidelines). */
export const jaCourseNames = ["数学I", "数学A", "数学II", "数学B", "数学III", "数学C"] as const;
export type JaCourseName = (typeof jaCourseNames)[number];

/**
 * Japanese middle-school maths. Divided by grade, not by course.
 *
 * The national guidelines allocate middle-school maths by grade (years 1-3), while
 * high-school maths is divided by course (Math I-C). Forcing them to match would
 * give one of them a division the guidelines do not have. The chip's `short` is
 * asymmetric for the same reason: "Grade 7" vs "Math I".
 */
export const jaJhsMathCourseNames = ["中学1年 数学", "中学2年 数学", "中学3年 数学"] as const;
export type JaJhsMathCourseName = (typeof jaJhsMathCourseNames)[number];

/**
 * Japanese middle-school English. Not divided by grade.
 *
 * The guidelines do not allocate middle-school English grammar by grade (appendix 7
 * of the commentary presents it for "middle school" as a whole). Making these
 * per-grade courses would let the grade be derived from the prefix, promoting an
 * allocation the guidelines never set into a specification. The rough grade is
 * isolated in `topicSchema.grade_hint` (display only).
 */
export const jaJhsEnglishCourseNames = ["中学英語"] as const;
export type JaJhsEnglishCourseName = (typeof jaJhsEnglishCourseNames)[number];

/**
 * Japanese high-school English. v1 carries only three courses.
 *
 * English Communication III and Logic & Expression II/III are not declared, because
 * there is no primary source at hand (appendix 9 of the commentary, "foreign
 * language materials") detailed enough to write their topics. A course declared
 * with no content becomes "selectable but shows nothing", which `checkIntegrity`'s
 * `empty-course` rejects.
 */
export const jaHsEnglishCourseNames = [
  "英語コミュニケーションI",
  "英語コミュニケーションII",
  "論理・表現I",
] as const;
export type JaHsEnglishCourseName = (typeof jaHsEnglishCourseNames)[number];

/** The overseas curricula. The six high-school maths courses common in US/international schools. */
export const enCourseNames = [
  "Algebra 1",
  "Geometry",
  "Algebra 2",
  "Precalculus",
  "Calculus",
  "Statistics",
] as const;
export type EnCourseName = (typeof enCourseNames)[number];

/** Which course names may belong to a track. Used to check `course-track-mismatch`. */
export const courseNamesByTrack: Record<TrackId, readonly string[]> = {
  hs_math_ja: jaCourseNames,
  hs_math_en: enCourseNames,
  jhs_math_ja: jaJhsMathCourseNames,
  jhs_english_ja: jaJhsEnglishCourseNames,
  hs_english_ja: jaHsEnglishCourseNames,
};

export const courseNames = [
  ...jaCourseNames,
  ...enCourseNames,
  ...jaJhsMathCourseNames,
  ...jaJhsEnglishCourseNames,
  ...jaHsEnglishCourseNames,
] as const;
export type CourseName =
  | JaCourseName
  | EnCourseName
  | JaJhsMathCourseName
  | JaJhsEnglishCourseName
  | JaHsEnglishCourseName;

export const jaCourseCodes = ["M1", "MA", "M2", "MB", "M3", "MC"] as const;
export const enCourseCodes = ["A1", "GE", "A2", "PC", "CL", "ST"] as const;
export const jaJhsMathCourseCodes = ["J1", "J2", "J3"] as const;
export const jaJhsEnglishCourseCodes = ["JE"] as const;
export const jaHsEnglishCourseCodes = ["E1", "E2", "L1"] as const;
export const courseCodes = [
  ...jaCourseCodes,
  ...enCourseCodes,
  ...jaJhsMathCourseCodes,
  ...jaJhsEnglishCourseCodes,
  ...jaHsEnglishCourseCodes,
] as const;
export type CourseCode = (typeof courseCodes)[number];

/** Course name -> topic_id prefix. Used to detect mismatches between id and course. */
export const courseCodeByName: Record<CourseName, CourseCode> = {
  数学I: "M1",
  数学A: "MA",
  数学II: "M2",
  数学B: "MB",
  数学III: "M3",
  数学C: "MC",
  "Algebra 1": "A1",
  Geometry: "GE",
  "Algebra 2": "A2",
  Precalculus: "PC",
  Calculus: "CL",
  Statistics: "ST",
  "中学1年 数学": "J1",
  "中学2年 数学": "J2",
  "中学3年 数学": "J3",
  中学英語: "JE",
  英語コミュニケーションI: "E1",
  英語コミュニケーションII: "E2",
  論理・表現I: "L1",
};

/**
 * topic_id prefix -> the curriculum with that prefix.
 *
 * This is ADR 0005's invariant made concrete. What used to be "prefix -> language"
 * is now two steps: "prefix -> curriculum -> (language, subject, stage)" (ADR 0007).
 * The property that one topic_id on a hole decides both the notification's language
 * and its subject is preserved.
 */
export const trackByCourseCode: Record<CourseCode, TrackId> = {
  M1: "hs_math_ja",
  MA: "hs_math_ja",
  M2: "hs_math_ja",
  MB: "hs_math_ja",
  M3: "hs_math_ja",
  MC: "hs_math_ja",
  A1: "hs_math_en",
  GE: "hs_math_en",
  A2: "hs_math_en",
  PC: "hs_math_en",
  CL: "hs_math_en",
  ST: "hs_math_en",
  J1: "jhs_math_ja",
  J2: "jhs_math_ja",
  J3: "jhs_math_ja",
  JE: "jhs_english_ja",
  E1: "hs_english_ja",
  E2: "hs_english_ja",
  L1: "hs_english_ja",
};

/**
 * A topic_id has the form `M2-ZUKEI-ENCHOKU` (Japanese high-school maths) or
 * `A2-COORD-CIRCLE` (overseas). Before whitelisting LLM output, it can be rejected
 * on shape alone.
 *
 * Prefixes never repeat across curricula. The id alone decides which curriculum a
 * topic belongs to, so a tag on a hole determines even the notification's language.
 *
 * The alternation lists longer prefixes first. A regex `|` tries left to right, so
 * this prevents the shorter one partially matching first if a pair like `J1` and
 * `JE1` is ever added, where one is a prefix of the other.
 */
const courseCodeAlternation = [...courseCodes]
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .join("|");

export const topicIdPattern = new RegExp(`^(${courseCodeAlternation})-[A-Z0-9]+(?:-[A-Z0-9]+)*$`);

export const topicIdSchema = z.string().regex(topicIdPattern, {
  message:
    "topic_idは M2-ZUKEI-ENCHOKU / A2-COORD-CIRCLE の形式(コース接頭辞 + 大文字ローマ字)である必要があります",
});

export const topicSchema = z
  .object({
    id: topicIdSchema,
    course: z.enum(courseNames),
    unit: z.string().min(1),
    topic: z.string().min(1),
    /**
     * Learning goals. The source material for generating questions and the axis for
     * judging the karte's "what they said well". Not just skills: at least one must
     * be answerable as an explanation ("can explain why ..." / "Explain why ...").
     */
    goals: z.array(z.string().min(1)).min(1),
    /** Used to dig into a hole ("what is a discriminant even for?"). */
    prerequisites: z.array(topicIdSchema),
    /** Clues for detecting the unit against the notes photo's analysis result. */
    keywords: z.array(z.string().min(1)).min(1),
    /**
     * A rough grade. Used for display labels only, never for scope decisions.
     *
     * The national guidelines do not allocate middle-school English grammar by grade
     * (appendix 7 of the commentary presents it for "middle school" as a whole and
     * states in the body that allocation is each school's and publisher's
     * discretion). "be-verbs in grade 7" is a textbook convention, so narrowing the
     * scope by it would erase units for students using a different textbook.
     *
     * `topicLabel()` is the only thing allowed to read it. That `suggestTopics`,
     * `buildAllowedTopics` and `resolveDetectedTopics` have no parameter for a grade
     * *at all* is what makes this promise real.
     *
     * It is not written for middle-school maths, where the grade follows from the
     * course itself ("Grade 7 maths"). That would be duplicate bookkeeping, and
     * `checkIntegrity` rejects it.
     */
    grade_hint: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })
  .strict();

export type Topic = z.infer<typeof topicSchema>;

export const courseSchema = z
  .object({
    code: z.enum(courseCodes),
    name: z.enum(courseNames),
    /**
     * The short name shown on chips and the plan screen: "Math I", "Grade 7", "EC I".
     *
     * Not omissible even when identical to `name`. Made optional, a curriculum where
     * it was forgotten would show its long official name on a chip, and nobody would
     * notice until it overflowed the screen. The 16-character cap fits
     * `Precalculus` (11) and the abbreviation of 英語コミュニケーションI, 英コミュI (5).
     * Never derive it by truncating `name` - the first six characters of
     * 英語コミュニケーションI are 英語コミュニ, which reads as no abbreviation at all.
     */
    short: z.string().min(1).max(16),
  })
  .strict();

export const curriculumSchema = z
  .object({
    version: z.string().min(1),
    /** Which curriculum. The content, not the file name, is authoritative. */
    track: trackIdSchema,
    curriculum: z.string().min(1),
    note: z.string().optional(),
    /**
     * The landing point for when even keyword inference misses.
     *
     * Needed for English curricula. Maths notes literally contain "discriminant" and
     * "√", but an English notebook never says "to-infinitive" - it contains English
     * sentences, so keyword matching barely works. Starting a lesson with nothing
     * left would leave the senpai talking with no scope.
     */
    fallback_topic_id: topicIdSchema.optional(),
    courses: z.array(courseSchema).min(1),
    topics: z.array(topicSchema).min(1),
  })
  .strict();

export type Curriculum = z.infer<typeof curriculumSchema>;
