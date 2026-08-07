import { z } from "zod";

/**
 * カルテ(セッション後のフィードバック)。
 *
 * 設計上の約束:
 *   - 点数・正答率のフィールドは **持たない**。数えるのは連続日数と埋めた穴の数だけ。
 *   - 「穴」は失点ではなく、これから埋まる場所として扱う。
 *   - 解答・解説はここに入らない(答えを教えないため)。
 *
 * 由来: handoff §4(c) 評価ルーブリック。
 */

/**
 * topic_idの形。中身がカリキュラム内かは @ai-sensei/guardrail が照合する。
 *
 * 接頭辞はコース(数学I〜C・英文法)の記号。ここは契約の境界なので
 * `@ai-sensei/curriculum` を実行時に持ち込まず、正規表現を写している。
 * ずれると正しいIDがAPIの入口で落ちるので、`karte.test.ts` で同期を見張る。
 */
export const topicIdSchema = z.string().regex(/^(M1|MA|M2|MB|M3|MC|EG)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/);

/**
 * 穴の深さ。点数ではなく「次にどれだけ効くか」の目安で、復習の優先順位に使う。
 * UIでは数値化せず、並び順にだけ効かせる。
 */
export const holeSeverities = ["low", "medium", "high"] as const;
export const holeSeveritySchema = z.enum(holeSeverities);
export type HoleSeverity = (typeof holeSeverities)[number];

export const holeDraftSchema = z
  .object({
    topic_id: topicIdSchema,
    /** 何が説明できなかったか。「〜で説明が止まった」の形で書く(責めない文体)。 */
    desc: z.string().min(1).max(200),
    severity: holeSeveritySchema,
    /** 根拠になったtranscript上の発話。カルテ画面では出さないが、再説明の文脈に使う。 */
    evidence: z.string().max(500).optional(),
  })
  .strict();
export type HoleDraft = z.infer<typeof holeDraftSchema>;

export const holeStatuses = ["open", "filled"] as const;
export const holeStatusSchema = z.enum(holeStatuses);

/**
 * 保存後の穴。復習フローの単位。
 *
 * `status` と `filled_at` は必ず対で動く。片方だけ立っていると、
 * 復習キュー(statusで絞る)と埋めた穴カウンター(filled_atが根拠)が
 * 食い違った数字を出すので、スキーマで組み合わせを縛る。
 */
export const holeSchema = holeDraftSchema
  .extend({
    id: z.string().min(1),
    status: holeStatusSchema,
    created_at: z.string().datetime(),
    /** 再説明で埋まった日時。埋めた穴カウンターの元データ。 */
    filled_at: z.string().datetime().nullable(),
  })
  .strict()
  .refine((hole) => (hole.status === "filled") === (hole.filled_at !== null), {
    message: "status=filled のときだけ filled_at を入れてください",
    path: ["filled_at"],
  });
export type Hole = z.infer<typeof holeSchema>;

/** agentがtranscript全体から生成する、保存前のカルテ。 */
export const karteDraftSchema = z
  .object({
    /** 言えたこと。カルテ画面では黄色のマーカーで示す。 */
    said_well: z.array(z.string().min(1).max(200)).max(10),
    holes: z.array(holeDraftSchema).max(5),
    /** 用語の取り違え。「『解の公式』と『判別式』が混同」のような短いメモ。 */
    term_notes: z.array(z.string().min(1).max(200)).max(5),
    /** 後輩のあと追い質問(Premium機能)。無料ユーザーには生成しない。 */
    followup_question: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();
export type KarteDraft = z.infer<typeof karteDraftSchema>;

/** 保存後のカルテ。カルテ画面と履歴が読むかたち。 */
export const karteSchema = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    created_at: z.string().datetime(),
    /** そのセッションで扱った単元。カルテ画面のヘッダに出す。 */
    topic_ids: z.array(topicIdSchema).min(1),
    // 長さの制約はドラフトと揃える。保存後だけ緩いと、fixtureとJSON Schemaで
    // 許容範囲が食い違う(片側だけ空文字や長文を通してしまう)。
    said_well: z.array(z.string().min(1).max(200)).max(10),
    holes: z.array(holeSchema).max(5),
    term_notes: z.array(z.string().min(1).max(200)).max(5),
    followup_question: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type Karte = z.infer<typeof karteSchema>;

/**
 * ホーム画面のカウンター。
 * XP・レベル・スコアは持たない(数えるのは努力だけ、という原則)。
 */
export const progressSchema = z
  .object({
    /** 連続日数。 */
    streak_days: z.number().int().min(0),
    /** 埋めた穴の累計。このアプリ固有のスコアで、共有スクショに出す想定。 */
    filled_holes: z.number().int().min(0),
    /** まだ埋まっていない穴の数。 */
    open_holes: z.number().int().min(0),
    /** 最後にセッションを完了した日(ローカル日付 YYYY-MM-DD)。 */
    last_session_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .strict();
export type Progress = z.infer<typeof progressSchema>;
