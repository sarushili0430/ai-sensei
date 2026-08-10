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
  updateSessionTopics: (sessionId: string) => `/v1/sessions/${sessionId}/topics`,
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

/* -------------------------------------------------------------------------- */
/* 問題文(グラウンディング)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * POST /v1/sessions の multipart のパート名。
 *
 * **2枚の写真は別のものとして扱う。寿命が違うから。**
 *
 * | パート | 中身 | 保存 |
 * | --- | --- | --- |
 * | `photo` | 生徒のノート(本人の著作物) | R2に保存する |
 * | `problem_photo` | 教科書・問題集の紙面(**他者の著作物**) | **解析後に破棄する。保存しない** |
 *
 * 計画書 §4-1 が「解析には送るが、R2に保存し続けるかは分けて判断する
 * (解析後破棄なら、将来の出版社交渉でも説明が立つ)」と書き、§10-4 で未決だったもの。
 * **破棄を既定にした**ので、パート名を分けて「どちらの寿命か」を送信側にも見えるようにする。
 *
 * **`kind: "new"` に要るのは、どちらか1枚。両方が無いときだけ弾く。**
 * どちらも必須ではない:
 *
 *   - `problem_photo` だけ … まだ手をつけていない問題を持ってきた場合。
 *     `visible_work` は空になり、`sessionMetadataSchema.visible_work` には
 *     「ノートの写真なし」を意味するプレースホルダが入る
 *   - `photo` だけ … 1枚に問題とノートの両方が写っている場合(§4-1 が「多い」と書いているほう)。
 *     解析器はノートの写真から問題文を読み取ろうとし、読めなければ問題文なしで進む
 *
 * **ノートを必須にしていた頃、この契約は自分自身の破棄の約束を破っていた。**
 * ノートが無い生徒は、紙面を `photo`(ノート枠)に入れる以外に送る手段が無く、
 * 結果として**他者の著作物がR2に保存されていた**。破棄を保証する道は
 * 「紙面をノート枠に入れる動機を消す」ことしかないので、ノートの必須をやめた。
 *
 * 「ノートを撮らない生徒を正規の経路として認めることになる」のは**承知のうえ**。
 * 旧方針(答えを教えない・説明させる)ではノート必須が必然だったが、
 * いまは教えるプロダクトで、「手も付けられない」は家庭教師の中心的な用件
 * (デッキ §0 の約束1の改正)。誤読の保険は教え返しフェーズ側にあるので無傷(§1-1)。
 *
 * **残る穴**: 生徒が問題を `photo` 枠に入れて送れば、それはノートとして保存される。
 * 枠の取り違えまでは防げない。防げるのは**取り違える動機**までで、そこは消した。
 */
export const sessionPhotoParts = {
  /** ノートの写真。R2に保存する。 */
  notes: "photo",
  /** 問題の写真。**解析後に破棄する。** */
  problem: "problem_photo",
} as const;

/**
 * 読み取った問題文の上限。
 *
 * 高校数学の設問は小問つきでも300字程度に収まる。600字は
 * **紙面を丸ごと書き起こさせないための安全弁**で、目標値ではない。
 * ページ全体を写すと、章末の解答や解説まで問題文として流れ込み、
 * 先輩が答えを読み上げるところから授業が始まってしまう。
 */
export const problemTextMaxLength = 600;

/**
 * 問題文をどの写真から読んだか。
 *
 * **ヒントの出しどころは「撮る前」に決めた**(2026-08-10)。当初この欄は
 * 「`null`(読めなかった)のときだけヒントを出す」ために置いたが、それは**解析のあと**になる。
 * 解析後に出すヒントは、撮り直さないと消えない警告として働き、
 * **任意のはずの2枚目が事実上の必須になる**(API側で「2枚目が壊れていても422にしない」と
 * 決めたのと同じ理屈が、UI側から無効化される)。撮る前なら同じ文言が純粋な促しなので、
 * §4-1「2枚必須にしない」を保ったまま「問題も写っていると先輩が迷子になりません」を出せる。
 * よってアプリは撮影の確認画面でヒントを**常時**出し、この欄では出しわけない。
 *
 * この欄はいま**観測のため**にある。
 *
 * どれくらいの生徒が実際に2枚送るかは、この値でしか観測できない。
 */
export const problemSources = ["problem_photo", "notes_photo"] as const;
export const problemSourceSchema = z.enum(problemSources);
export type ProblemSource = (typeof problemSources)[number];

/**
 * セッションが扱う問題。**読み取れたときだけ存在する。**
 *
 * `text` と `source` を1つのオブジェクトにまとめてあるのは、
 * 「本文はあるが出どころが無い」という状態を表現できなくするため
 * (`karte.ts` の `status` / `filled_at` を対で縛っているのと同じ考え方)。
 */
export const sessionProblemSchema = z
  .object({
    /**
     * 問題文。**解答・解説は入らない。**
     * 中身が本当に設問かどうかの照合は contract の仕事ではない
     * (`topicIdSchema` と同じ分担で、`@ai-sensei/guardrail` 側)。
     */
    text: z.string().min(1).max(problemTextMaxLength),
    source: problemSourceSchema,
  })
  .strict();
export type SessionProblem = z.infer<typeof sessionProblemSchema>;

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
    /**
     * この応答時点から、今日さらに授業を始められるか。
     * §6-3「UIに数字は一切出さない」を契約の形で守るため、残数ではなく可否だけを返す。
     */
    lesson_allowed_today: z.boolean(),
  })
  .strict();

export const createSessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    kind: sessionKindSchema,
    livekit: liveKitConnectionSchema,
    detected_topics: z.array(detectedTopicSchema).min(1),
    /**
     * 解析が読み取った問題。**読めなければ `null`**(それでもセッションは成立する)。
     *
     * アプリに返すのは2つの用途のため:
     *   1. `null` のときだけ §4-1 のヒント(「問題も写っていると〜」)を出す
     *   2. **読み取った問題文をそのまま見せる。** 誤読が表面化するのがここで最も早い。
     *      §1-1 の「AIが理解している建て付けのアプリほど誤読が致命傷になる」への、
     *      授業が始まる前の手当て。
     */
    problem: sessionProblemSchema.nullable(),
    limits: sessionLimitsSchema,
  })
  .strict();
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

/**
 * PATCH /v1/sessions/{id}/topics のリクエスト。
 *
 * チップUIで外した単元を、**セッションを作り直さずに**反映する。
 * 作り直すと無料枠(1日1回)をもう1回消費してしまい、単元を確認して
 * 会話を始めた瞬間に「今日のセッションはここまで」と言われてしまう。
 */
export const updateSessionTopicsRequestSchema = z
  .object({
    locale: localeSchema.default("ja"),
    /** 残す単元。解析で検出したものの部分集合でなければならない。 */
    topic_ids: z.array(topicIdSchema).min(1).max(5),
  })
  .strict();
export type UpdateSessionTopicsRequest = z.infer<typeof updateSessionTopicsRequestSchema>;
export type UpdateSessionTopicsRequestInput = z.input<typeof updateSessionTopicsRequestSchema>;

/** 返るものは作成時と同じ(session_idは変わらず、トークンだけ出し直す)。 */
export type UpdateSessionTopicsResponse = CreateSessionResponse;

/**
 * **LiveKitトークンに載せて agent に渡す会話文脈。**
 *
 * HTTPのボディではなく、トークンの `metadata` クレーム(と、名前つきワーカーのときは
 * ディスパッチのジョブ metadata)に**JSON文字列として**入る。だから「主なエンドポイント」の
 * 表には出てこないが、**backend/api と agent の間の契約としてはいちばん重い**もので、
 * ここが会話プロンプトの穴埋めにそのまま流れ込む。
 *
 * 型が無いまま運用していた結果、agent は `problem_text` に `photo_summary` を
 * 流用していた(= **先輩が問題そのものを見ないまま教えていた**)。§0 の決定4
 * 「問題とノートをセットで送る」が実装されていなかったのは、ここに欄が無かったため。
 *
 * **文字列の欄は「整形済みでそのままプロンプトに貼る」もの。**
 * 空のときのプレースホルダまで含めて、`locale` の言語で揃えて入れる
 * (日本語の「(なし)」が英語のプロンプトに混ざると、そこだけ日本語で返ってくる)。
 */
export const sessionMetadataSchema = z
  .object({
    session_id: z.string().min(1),
    /**
     * **会話の言語。アプリの表示言語ではなく、扱う単元の課程で決まる**(ADR 0005)。
     * 復習セッションでは、穴に付いた topic_id の接頭辞から決まる。
     */
    locale: localeSchema,
    kind: sessionKindSchema,
    max_seconds: z.number().int().positive(),
    /** 写真解析の要約。「何が写っているか」であって、問題文ではない。 */
    photo_summary: z.string(),
    /**
     * **問題文。空文字は入らない**(`.min(1)`)。
     *
     * 読み取れなかった場合も、**その言語のプレースホルダが入った状態で届く**
     * (日本語なら「(問題の写真なし)」)。agent 側で空を埋める必要はない。
     * 埋める場所が2つあると、プロンプトが期待する文言と実際に届く文言がずれ、
     * **先輩が問題を推測で組み立てはじめる**(`prompts/senpai_board.*.md` が
     * このプレースホルダを名指しで見ている)。
     */
    problem_text: z.string().min(1),
    /**
     * ノートに書いてあること(整形済みの箇条書き)。**空にならない**(`.min(1)`)。
     *
     * `problem_text` と同じ扱いで、**3つの状態が区別できる形で届く**:
     *
     *   - 箇条書き … ノートの写真から読み取れた
     *   - 「(なし)」相当 … ノートは撮ったが、手をつけた形跡が読み取れなかった
     *   - 「(ノートの写真なし)」相当 … **ノートの写真そのものが無い**
     *     (問題だけを持ってきた = まだ手をつけていない。`sessionPhotoParts` を参照)
     *
     * 3つ目は `problem_photo` だけを送る経路が正規化されたことで生まれた状態で、
     * **「読み取れなかった」とは別物**。混ぜると、先輩は
     * 「ノートに何も書いていない生徒」と「ノートを撮らなかった生徒」を同じに扱う。
     */
    visible_work: z.string().min(1),
    /** 整形済みの箇条書き。 */
    question_seeds: z.string(),
    /** 整形済みの許可トピック一覧(到達目標つき)。 */
    allowed_topics: z.string(),
    /** ガードレールの照合に使う生のID。前提トピックまで含む。 */
    allowed_topic_ids: z.array(topicIdSchema),
    is_premium: z.boolean(),
  })
  .strict();
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

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
