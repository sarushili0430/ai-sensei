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
 * 接頭辞は課程ごと。`M1`〜`MC` が日本の数学I〜C、`A1`(Algebra 1)・`GE`
 * (Geometry)・`A2`(Algebra 2)・`PC`(Precalculus)・`CL`(Calculus)・
 * `ST`(Statistics)が海外向けの課程。
 *
 * **`@ai-sensei/curriculum` の `topicIdPattern` と同じ形にすること。**
 * contract は依存を持たない層なので参照できず、二重に書いている
 * (ずれると `backend/api` の photo-analysis のテストで落ちる)。
 */
export const topicIdSchema = z
  .string()
  .regex(/^(M1|MA|M2|MB|M3|MC|A1|GE|A2|PC|CL|ST)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/);

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
    /**
     * 1/3/7日後に出す**1問**。10秒で答えられる短さにする。
     *
     * 出題元はtranscriptのうち、本人が説明した内容(`ユーザー:` / `Student:`)だけ。
     * 先輩が教えた内容から作らない。AIの誤読を間隔反復で3回強化してしまうため
     * (ピボット計画 §2 の却下表)。
     *
     * 採点はせず、答えも持たない。本人が「言えた / まだ言えない」を選ぶだけ。
     * 旧データには無いので省略でき、無いときは `desc` を出題として使う。
     */
    quiz: z.string().min(1).max(200).optional(),
  })
  .strict();
export type HoleDraft = z.infer<typeof holeDraftSchema>;

export const holeStatuses = ["open", "filled"] as const;
export const holeStatusSchema = z.enum(holeStatuses);

/**
 * 穴の復習結果。採点ではなく、言えたかどうかを本人が申告する二択。
 *
 * `not_yet` を選んだことを咎める文言はUIに置かない。
 * 約束3「パスを恥にしない」を復習でも守る。
 */
export const reviewOutcomes = ["said_it", "not_yet"] as const;
export const reviewOutcomeSchema = z.enum(reviewOutcomes);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

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
