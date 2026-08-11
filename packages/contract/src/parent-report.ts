import { z } from "zod";
import { topicIdSchema } from "./karte.ts";

/**
 * 親レポートの契約(ピボット計画 §5-2)。
 *
 * この境界には、載せてよいものだけを置く。親向けの画面は「分かりやすい数字」を
 * 求められやすく、あとから正答率・理解度スコア・偏差値・順位を足す誘惑が最も強い。
 * `.strict()` で余分な欄を拒否し、数値欄も「埋めた穴」と「連続日数」の2つに閉じる。
 * **禁止欄をコメントで列挙するだけでは、型補完にも実行時検証にも効かない**ため、
 * ロック状態を含めて表現できる状態そのものをここで限定する。
 */

/** `said_well` から親へ見せる、本人の言葉の最大件数。 */
export const parentReportQuoteMaxCount = 3;

/**
 * 引用1件の上限。出どころの `said_well` と同じ200文字に揃える。
 * 共有のために途中で切ると本人が言った意味を変えうるので、表示側で短くしない。
 */
export const parentReportQuoteMaxLength = 200;

/**
 * 1か月に単元を詰め込みすぎないための上限。
 * 網羅性より「どんなことを説明したか」が一目で伝わることを優先する。
 */
export const parentReportTopicMaxCount = 12;
export const parentReportTopicNameMaxLength = 100;

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const parentReportPeriodSchema = z
  .object({
    /** 今月の初日(ユーザーのローカル日付)。 */
    start_date: localDateSchema,
    /** 作成日。まだ来ていない月末まで学んだようには見せない。 */
    end_date: localDateSchema,
  })
  .strict();
export type ParentReportPeriod = z.infer<typeof parentReportPeriodSchema>;

export const parentReportTopicSchema = z
  .object({
    /** 中身の妥当性は curriculum / guardrail が照合する。contract は形だけを守る。 */
    topic_id: topicIdSchema,
    /** 親が読む単元名。IDだけでは紙の答案との違いが伝わらない。 */
    name: z.string().min(1).max(parentReportTopicNameMaxLength),
  })
  .strict();
export type ParentReportTopic = z.infer<typeof parentReportTopicSchema>;

export const parentReportSchema = z
  .object({
    period: parentReportPeriodSchema,
    /** この期間に埋まった穴。通算ではなく、今月増えたものだけ。 */
    filled_holes: z.number().int().min(0),
    /** 作成日時点の連続日数。既存の進捗と同じ数え方を使う。 */
    streak_days: z.number().int().min(0),
    /** `said_well` または今月埋まった穴を根拠にした単元名。 */
    explained_topics: z.array(parentReportTopicSchema).max(parentReportTopicMaxCount),
    /** 本人が実際に口にした説明。出どころはカルテの `said_well` だけ。 */
    quotes: z
      .array(z.string().min(1).max(parentReportQuoteMaxLength))
      .max(parentReportQuoteMaxCount),
  })
  .strict();
export type ParentReport = z.infer<typeof parentReportSchema>;

const lockedParentReportResponseSchema = z
  .object({
    requires_premium: z.literal(true),
    /**
     * 無料ユーザーにも200で返すが、本文は返さない。
     * boolean と nullable を独立させると「lockedなのに本文あり」を作れてしまい、
     * 有料境界がクライアントごとに変わるので、この組み合わせだけを許す。
     */
    report: z.null(),
  })
  .strict();

const openParentReportResponseSchema = z
  .object({
    requires_premium: z.literal(false),
    report: parentReportSchema,
  })
  .strict();

/** 無料ユーザーをエラーにしない、`/v1/me/reviews` と同じロック表現。 */
export const parentReportResponseSchema = z.discriminatedUnion("requires_premium", [
  lockedParentReportResponseSchema,
  openParentReportResponseSchema,
]);
export type ParentReportResponse = z.infer<typeof parentReportResponseSchema>;
