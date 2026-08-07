import { z } from "zod";

/**
 * カリキュラムは**地域ごとに1本**持つ。
 *
 * 日本の高校数学(数学I〜C)と、海外の高校数学(Algebra 1 → Geometry →
 * Algebra 2 → Precalculus → Calculus + Statistics)は、単元の切り方も名前も
 * 違う。片方を訳して使い回すと「Math II」のような、どこの国にも無い科目名が
 * 画面と通知に出てしまうので、**別のマップとして持つ**。
 *
 * 対応づけの正はロケール。`ja` は日本の課程、`en` は海外向けの課程を指す。
 */
export const curriculumLocales = ["ja", "en"] as const;
export type CurriculumLocale = (typeof curriculumLocales)[number];
export const curriculumLocaleSchema = z.enum(curriculumLocales);

/** 日本の課程(新課程の6科目)。 */
export const jaCourseNames = ["数学I", "数学A", "数学II", "数学B", "数学III", "数学C"] as const;
export type JaCourseName = (typeof jaCourseNames)[number];

/** 海外向けの課程。US/international の高校数学で通りのいい6コース。 */
export const enCourseNames = [
  "Algebra 1",
  "Geometry",
  "Algebra 2",
  "Precalculus",
  "Calculus",
  "Statistics",
] as const;
export type EnCourseName = (typeof enCourseNames)[number];

export const courseNamesByLocale: Record<CurriculumLocale, readonly string[]> = {
  ja: jaCourseNames,
  en: enCourseNames,
};

export const courseNames = [...jaCourseNames, ...enCourseNames] as const;
export type CourseName = JaCourseName | EnCourseName;

export const jaCourseCodes = ["M1", "MA", "M2", "MB", "M3", "MC"] as const;
export const enCourseCodes = ["A1", "GE", "A2", "PC", "CL", "ST"] as const;
export const courseCodes = [...jaCourseCodes, ...enCourseCodes] as const;
export type CourseCode = (typeof courseCodes)[number];

/** コース名 → topic_id の接頭辞。IDとcourseの食い違いを検出するのに使う。 */
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
};

/** topic_id の接頭辞 → その接頭辞を持つカリキュラムのロケール。 */
export const localeByCourseCode: Record<CourseCode, CurriculumLocale> = {
  M1: "ja",
  MA: "ja",
  M2: "ja",
  MB: "ja",
  M3: "ja",
  MC: "ja",
  A1: "en",
  GE: "en",
  A2: "en",
  PC: "en",
  CL: "en",
  ST: "en",
};

/**
 * topic_id は `M2-ZUKEI-ENCHOKU`(日本)/ `A2-COORD-CIRCLE`(海外)の形。
 * LLMの出力をホワイトリスト照合する前に、まず形で弾けるようにしている。
 *
 * **接頭辞はロケールをまたいで重複させない。** IDだけ見ればどちらの課程の
 * トピックか決まるので、穴に付いたタグから通知の言語まで一意に決まる。
 */
export const topicIdPattern = new RegExp(`^(${courseCodes.join("|")})-[A-Z0-9]+(?:-[A-Z0-9]+)*$`);

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
     * 到達目標。質問生成のネタ元であり、カルテの「言えたこと」の判定軸でもある。
     * 技能だけで終わらせず、最低1つは説明を問える形(「〜の理由を説明できる」/
     * "Explain why ...")にする。
     */
    goals: z.array(z.string().min(1)).min(1),
    /** 穴の深掘りに使う(「そもそも判別式って何のためにある?」)。 */
    prerequisites: z.array(topicIdSchema),
    /** ノート写真の解析結果と突き合わせて単元を検出するための手がかり。 */
    keywords: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type Topic = z.infer<typeof topicSchema>;

export const courseSchema = z
  .object({
    code: z.enum(courseCodes),
    name: z.enum(courseNames),
  })
  .strict();

export const curriculumSchema = z
  .object({
    version: z.string().min(1),
    /** どの地域の課程か。ファイル名ではなく中身を正にする。 */
    locale: curriculumLocaleSchema,
    curriculum: z.string().min(1),
    note: z.string().optional(),
    courses: z.array(courseSchema).min(1),
    topics: z.array(topicSchema).min(1),
  })
  .strict();

export type Curriculum = z.infer<typeof curriculumSchema>;
