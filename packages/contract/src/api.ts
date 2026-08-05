import { z } from "zod";
import {
  holeSchema,
  karteDraftSchema,
  karteSchema,
  progressSchema,
  topicIdSchema,
} from "./karte.ts";

/**
 * backend/api ↔ apps/mobile ↔ agent の契約。
 * ここを変えたら fixtures/ も更新する(fixtureはFlutter側のテストからも読まれる)。
 */

export const apiPaths = {
  createSession: "/v1/sessions",
  completeSession: (sessionId: string) => `/v1/sessions/${sessionId}/complete`,
  progress: "/v1/me/progress",
  reviewQueue: "/v1/me/reviews",
  revenueCatWebhook: "/v1/webhooks/revenuecat",
} as const;

export const locales = ["ja", "en"] as const;
export const localeSchema = z.enum(locales);
export type Locale = (typeof locales)[number];

/** セッションの種類。復習は既存の穴から入るので写真がいらない。 */
export const sessionKinds = ["new", "review"] as const;
export const sessionKindSchema = z.enum(sessionKinds);

/** 写真解析で検出した単元。UIではチップで出し、ユーザーが直せる。 */
export const detectedTopicSchema = z
  .object({
    topic_id: topicIdSchema,
    course: z.string().min(1),
    unit: z.string().min(1),
    topic: z.string().min(1),
    /** 0..1。低いものは選択済みにせず、候補として並べるだけにする。 */
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type DetectedTopic = z.infer<typeof detectedTopicSchema>;

/**
 * POST /v1/sessions のリクエスト。
 * 写真そのものは multipart/form-data の `photo` パートで送り、
 * 残りのフィールドを `meta` パートにこのJSONで入れる。
 */
export const createSessionRequestSchema = z
  .object({
    kind: sessionKindSchema.default("new"),
    locale: localeSchema.default("ja"),
    /** kind="review" のとき、埋めにいく穴。復習は穴が起点なので必須。 */
    hole_id: z.string().min(1).optional(),
    /** ユーザーがチップUIで単元を直した場合の指定。空なら写真解析に任せる。 */
    topic_ids: z.array(topicIdSchema).max(5).optional(),
  })
  .strict()
  .refine((request) => request.kind !== "review" || request.hole_id !== undefined, {
    message: "kind=review には hole_id が必要です",
    path: ["hole_id"],
  });

/**
 * パース**後**の型。`kind`/`locale` は default が効くので必ず入っている。
 * サーバ側の処理はこちらを使う。
 */
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

/**
 * パース**前**(ワイヤー上)の型。`kind`/`locale` は省略できる。
 * クライアントがリクエストを組み立てるときはこちらを使う。
 */
export type CreateSessionRequestInput = z.input<typeof createSessionRequestSchema>;

export const liveKitConnectionSchema = z
  .object({
    url: z.string().url(),
    /** 参加用トークン。短命(セッション長+バッファ)。 */
    token: z.string().min(1),
    room: z.string().min(1),
  })
  .strict();

export const sessionLimitsSchema = z
  .object({
    /** サーバが強制する上限。無料は5分、Premiumは15分。 */
    max_seconds: z.number().int().positive(),
    /** その日に残っているセッション数。Premiumはnull(無制限)。 */
    remaining_sessions_today: z.number().int().min(0).nullable(),
  })
  .strict();

export const createSessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    kind: sessionKindSchema,
    livekit: liveKitConnectionSchema,
    detected_topics: z.array(detectedTopicSchema).min(1),
    limits: sessionLimitsSchema,
  })
  .strict();
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

/** 会話ログ。assistant=後輩の発話、user=ユーザーの説明。 */
export const transcriptMessageSchema = z
  .object({
    role: z.enum(["assistant", "user"]),
    text: z.string(),
    /** セッション開始からの経過ミリ秒。 */
    at_ms: z.number().int().min(0),
    /** その発話が扱っていた単元(後輩の質問には必ず付く)。 */
    topic_id: topicIdSchema.optional(),
  })
  .strict();
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

/**
 * POST /v1/sessions/{id}/complete — agentが呼ぶ。
 * 内部呼び出しなので Authorization: Bearer <INTERNAL_API_TOKEN> が要る。
 */
export const completeSessionRequestSchema = z
  .object({
    transcript: z.array(transcriptMessageSchema),
    karte: karteDraftSchema,
    duration_seconds: z.number().int().min(0),
    /** 会話が最後まで行かずに切れた場合。カルテは作るが穴の重み付けを控えめにする。 */
    ended_reason: z.enum(["completed", "timeout", "user_left", "error"]),
  })
  .strict();
export type CompleteSessionRequest = z.infer<typeof completeSessionRequestSchema>;

/** 復習プッシュの予約。間隔反復は 翌日 → 3日後 → 7日後 の3段階。 */
export const reviewScheduleEntrySchema = z
  .object({
    hole_id: z.string().min(1),
    /** 1=翌日 / 2=3日後 / 3=7日後 */
    step: z.number().int().min(1).max(3),
    scheduled_at: z.string().datetime(),
  })
  .strict();
export type ReviewScheduleEntry = z.infer<typeof reviewScheduleEntrySchema>;

export const completeSessionResponseSchema = z
  .object({
    karte: karteSchema,
    review_schedule: z.array(reviewScheduleEntrySchema),
    progress: progressSchema,
    /** 初回カルテ直後にペイウォールを出すかどうか(出す位置はサーバが決める)。 */
    show_paywall: z.boolean(),
  })
  .strict();
export type CompleteSessionResponse = z.infer<typeof completeSessionResponseSchema>;

/** 復習画面(プッシュ起点)が読むキュー。 */
export const reviewQueueItemSchema = z
  .object({
    hole: holeSchema,
    topic_id: topicIdSchema,
    /** 「3日前」の表示に使う。 */
    days_since: z.number().int().min(0),
    /** 通知文と同じ、後輩の声のひとこと。 */
    prompt: z.string().min(1).max(200),
  })
  .strict();
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

/**
 * 埋まった穴。ペイウォールが謳う Premium の「履歴」はこれで果たす。
 * 別画面の履歴は作らず、復習画面の下半分に置く(埋めにいく穴 ↔ 埋めた穴)。
 */
export const filledHoleSchema = z
  .object({
    hole: holeSchema,
    topic_id: topicIdSchema,
    /** 「きのう埋めた」の表示に使う。 */
    days_since_filled: z.number().int().min(0),
  })
  .strict();
export type FilledHole = z.infer<typeof filledHoleSchema>;

/** 復習画面が一度に受け取る、埋めた穴の最大件数。 */
export const filledHolesLimit = 30;

export const reviewQueueResponseSchema = z
  .object({
    items: z.array(reviewQueueItemSchema),
    /**
     * 埋めた穴(新しい順)。通算の件数は progress.filled_holes のほうが正で、
     * ここは直近 {@link filledHolesLimit} 件までしか載らない。
     */
    filled: z.array(filledHoleSchema).max(filledHolesLimit),
    /** 無料ユーザーには空配列を返し、これをtrueにする(復習はPremium)。 */
    requires_premium: z.boolean(),
  })
  .strict();
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

export const progressResponseSchema = z
  .object({
    progress: progressSchema,
    is_premium: z.boolean(),
    limits: sessionLimitsSchema,
  })
  .strict();
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

/** エラー。クライアントは code で分岐する(messageは表示用で変わりうる)。 */
export const apiErrorCodes = [
  "unauthorized",
  "free_limit_reached",
  "premium_required",
  "photo_unreadable",
  "out_of_scope",
  "session_not_found",
  "rate_limited",
  "internal_error",
] as const;
export const apiErrorCodeSchema = z.enum(apiErrorCodes);
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        /** ユーザーにそのまま出せる日本語/英語の文言。煽らない文体で書く。 */
        message: z.string().min(1),
        /** 再試行の目安秒数(rate_limited / free_limit_reached のとき)。 */
        retry_after_seconds: z.number().int().min(0).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;
