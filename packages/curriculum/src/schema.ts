import { z } from "zod";

/** コース(科目)。新課程の6科目。 */
export const courseNames = ["数学I", "数学A", "数学II", "数学B", "数学III", "数学C"] as const;
export type CourseName = (typeof courseNames)[number];

export const courseCodes = ["M1", "MA", "M2", "MB", "M3", "MC"] as const;
export type CourseCode = (typeof courseCodes)[number];

/** コース名 → topic_id の接頭辞。IDとcourseの食い違いを検出するのに使う。 */
export const courseCodeByName: Record<CourseName, CourseCode> = {
  数学I: "M1",
  数学A: "MA",
  数学II: "M2",
  数学B: "MB",
  数学III: "M3",
  数学C: "MC",
};

/**
 * topic_id は `M2-ZUKEI-ENCHOKU` の形。
 * LLMの出力をホワイトリスト照合する前に、まず形で弾けるようにしている。
 */
export const topicIdPattern = /^(M1|MA|M2|MB|M3|MC)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export const topicIdSchema = z.string().regex(topicIdPattern, {
  message: "topic_idは M2-ZUKEI-ENCHOKU の形式(コース接頭辞 + 大文字ローマ字)である必要があります",
});

export const topicSchema = z
  .object({
    id: topicIdSchema,
    course: z.enum(courseNames),
    unit: z.string().min(1),
    topic: z.string().min(1),
    /** 到達目標。質問生成のネタ元であり、カルテの「言えたこと」の判定軸でもある。 */
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
    curriculum: z.string().min(1),
    note: z.string().optional(),
    courses: z.array(courseSchema).min(1),
    topics: z.array(topicSchema).min(1),
  })
  .strict();

export type Curriculum = z.infer<typeof curriculumSchema>;
