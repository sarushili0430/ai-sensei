import { z } from "zod";

/**
 * **指導言語。** 先輩が話す言語であり、ガードレールの語彙でもある。
 *
 * 「どの課程か」はここでは決まらない({@link TrackId} の役目)。ADR 0005 では
 * この値が課程も兼ねていたが、「日本の中学生が英語を学ぶ」= *課程は英語 /
 * 指導言語は日本語* が表せないので、課程を {@link CurriculumTrack} に切り出した
 * (ADR 0007)。**この型に `"ja-english"` のような値を足してはいけない** —
 * `Record<CurriculumLocale, ...>` はプロンプト・ガードレールの各所にあり、
 * どれも「言語ごとに1本」を意味している。
 */
export const curriculumLocales = ["ja", "en"] as const;
export type CurriculumLocale = (typeof curriculumLocales)[number];
export const curriculumLocaleSchema = z.enum(curriculumLocales);

/**
 * 学校段階。**プロンプトに貼る課程を絞る**のに使う。
 *
 * 全課程を貼ると、写真解析も計画の聞き取りも「中学生に数学IIを勧める」余地を
 * 持ったまま走る。段階で半分に切ると、その余地が構造的に消える。
 */
export const schoolStages = ["junior_high", "high_school"] as const;
export type SchoolStage = (typeof schoolStages)[number];
export const schoolStageSchema = z.enum(schoolStages);

/**
 * 教科。**板書に使える要素**と**同梱する音声補正ヒント**の分岐軸。
 *
 * 数学の板書は数式(latex/plot/triangle/circle)、英語の板書は例文と対比表で、
 * 使ってよい要素の集合が重ならない。音声補正も同じで、「さんぶんのに = 2/3」を
 * 英語の発話に当てると、言えているのに詰まったと判定する。
 */
export const curriculumSubjects = ["math", "english"] as const;
export type CurriculumSubject = (typeof curriculumSubjects)[number];
export const curriculumSubjectSchema = z.enum(curriculumSubjects);

/**
 * 課程。**1 track = 1 JSONファイル**で、これが「触れてよい話題」を分ける単位。
 *
 * 課程を足すときは、ここに id を足す → `tracks` に定義を足す →
 * `trackByCourseCode` に接頭辞を足す → データファイルを足す、の順。
 * `curricula` が `Record<TrackId, Curriculum>` なので、**id だけ足して
 * データを忘れると型で落ちる**。
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
  /** 先輩が話す言語。教える中身の言語ではない。 */
  locale: CurriculumLocale;
  subject: CurriculumSubject;
  stage: SchoolStage;
};

export const tracks: Record<TrackId, CurriculumTrack> = {
  hs_math_ja: { id: "hs_math_ja", locale: "ja", subject: "math", stage: "high_school" },
  hs_math_en: { id: "hs_math_en", locale: "en", subject: "math", stage: "high_school" },
  jhs_math_ja: { id: "jhs_math_ja", locale: "ja", subject: "math", stage: "junior_high" },
  // 日本の中学生が学ぶ英語。**指導言語は日本語**(先輩は日本語で話す)。
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

/** 日本の高校数学(新課程の6科目)。 */
export const jaCourseNames = ["数学I", "数学A", "数学II", "数学B", "数学III", "数学C"] as const;
export type JaCourseName = (typeof jaCourseNames)[number];

/**
 * 日本の中学数学。**科目ではなく学年で区切る。**
 *
 * 学習指導要領が中学校数学を学年別(第1〜3学年)に配当しているのに対し、
 * 高校数学は科目(数学I〜C)で区切られている。ここを無理に揃えると、
 * どちらかが指導要領に無い区切りになる。チップの `short` も同じ理由で
 * 「中1」/「数学I」と非対称になる。
 */
export const jaJhsMathCourseNames = ["中学1年 数学", "中学2年 数学", "中学3年 数学"] as const;
export type JaJhsMathCourseName = (typeof jaJhsMathCourseNames)[number];

/**
 * 日本の中学英語。**学年で分けない。**
 *
 * 学習指導要領は中学校英語の文法事項を学年別に配当していない(解説の付録7は
 * 「中学校」一括)。ここを学年別のコースにすると、接頭辞で学年が引けてしまい、
 * **指導要領が定めていない配当を仕様に格上げする**ことになる。
 * 学年の目安は `topicSchema.grade_hint`(表示専用)に隔離してある。
 */
export const jaJhsEnglishCourseNames = ["中学英語"] as const;
export type JaJhsEnglishCourseName = (typeof jaJhsEnglishCourseNames)[number];

/**
 * 日本の高校英語。**v1で持つのは3科目だけ。**
 *
 * 英語コミュニケーションIII・論理・表現II/III は、トピックを書けるだけの
 * 一次ソース(解説の付録9「外国語の言語材料」)が手元に無いので**宣言しない**。
 * 宣言だけして中身が無いコースは「選べるのに何も出てこない」になるため、
 * `checkIntegrity` の `empty-course` がそれを落とす。
 */
export const jaHsEnglishCourseNames = [
  "英語コミュニケーションI",
  "英語コミュニケーションII",
  "論理・表現I",
] as const;
export type JaHsEnglishCourseName = (typeof jaHsEnglishCourseNames)[number];

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

/** その課程に入ってよい科目名。`course-track-mismatch` の照合に使う。 */
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
  "中学1年 数学": "J1",
  "中学2年 数学": "J2",
  "中学3年 数学": "J3",
  中学英語: "JE",
  英語コミュニケーションI: "E1",
  英語コミュニケーションII: "E2",
  論理・表現I: "L1",
};

/**
 * topic_id の接頭辞 → その接頭辞を持つ課程。
 *
 * ここが ADR 0005 の不変条件の実体。従来は「接頭辞 → 言語」だったものを
 * 「接頭辞 → 課程 → (言語, 教科, 段階)」の2段にした(ADR 0007)。
 * **穴に付いた topic_id ひとつから、通知の言語も教科も決まる**という性質は
 * そのまま保たれている。
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
 * topic_id は `M2-ZUKEI-ENCHOKU`(日本の高校数学)/ `A2-COORD-CIRCLE`(海外)の形。
 * LLMの出力をホワイトリスト照合する前に、まず形で弾けるようにしている。
 *
 * **接頭辞は課程をまたいで重複させない。** IDだけ見ればどの課程のトピックか
 * 決まるので、穴に付いたタグから通知の言語まで一意に決まる。
 *
 * 交替は**長い接頭辞から並べる**。正規表現の `|` は左から試すので、`J1` と
 * `JE1` のように片方がもう片方の先頭に見える組み合わせを足したときに、
 * 短いほうが先に部分一致して落ちるのを防ぐ。
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
     * 到達目標。質問生成のネタ元であり、カルテの「言えたこと」の判定軸でもある。
     * 技能だけで終わらせず、最低1つは説明を問える形(「〜の理由を説明できる」/
     * "Explain why ...")にする。
     */
    goals: z.array(z.string().min(1)).min(1),
    /** 穴の深掘りに使う(「そもそも判別式って何のためにある?」)。 */
    prerequisites: z.array(topicIdSchema),
    /** ノート写真の解析結果と突き合わせて単元を検出するための手がかり。 */
    keywords: z.array(z.string().min(1)).min(1),
    /**
     * 学年の目安。**表示ラベルにだけ使う。範囲の判定には絶対に使わない。**
     *
     * 学習指導要領は中学校英語の文法事項を**学年別に配当していない**
     * (解説の付録7は「中学校」一括で示し、配当は各校・教科書会社の裁量と
     * 本文に明記されている)。「中1でbe動詞」は教科書側の慣行なので、
     * これで範囲を絞ると、別の教科書を使っている生徒の単元が消える。
     *
     * 読んでよいのは `topicLabel()` ただ1つ。`suggestTopics` /
     * `buildAllowedTopics` / `resolveDetectedTopics` には学年を渡す引数が
     * **存在しない**のが、この約束の実体。
     *
     * 学年が課程そのもので決まる中学数学(course が「中学1年 数学」)には
     * 書かない。二重管理になるため、`checkIntegrity` が弾く。
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
     * チップと計画画面に出す短い名前。「数学I」「中1」「英コミュI」。
     *
     * **`name` と同じでも省略できない。** optional にすると、書き忘れた課程が
     * 長い正式名のままチップに出て、画面からはみ出すまで誰も気づかない。
     * 上限16は `Precalculus`(11)・`英語コミュニケーションI` の略「英コミュI」(5)が
     * 収まる幅。`name` を機械的に切り詰めて作らないこと —
     * 「英語コミュニケーションI」の頭6字は「英語コミュニ」で、略称として読めない。
     */
    short: z.string().min(1).max(16),
  })
  .strict();

export const curriculumSchema = z
  .object({
    version: z.string().min(1),
    /** どの課程か。ファイル名ではなく中身を正にする。 */
    track: trackIdSchema,
    curriculum: z.string().min(1),
    note: z.string().optional(),
    /**
     * キーワード推定まで空振りしたときの着地点。
     *
     * 英語の課程で要る。数学は「判別式」「√」がそのままノートに写るが、
     * **英語のノートに「to不定詞」とは書かれていない** — 写っているのは英文で、
     * キーワード照合が効きにくい。1件も残らないまま授業を始めると、
     * 先輩は範囲なしで喋ることになる。
     */
    fallback_topic_id: topicIdSchema.optional(),
    courses: z.array(courseSchema).min(1),
    topics: z.array(topicSchema).min(1),
  })
  .strict();

export type Curriculum = z.infer<typeof curriculumSchema>;
