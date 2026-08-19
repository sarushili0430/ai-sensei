import { z } from "zod";
import {
  holeSchema,
  karteDraftSchema,
  karteSchema,
  progressSchema,
  reviewOutcomeSchema,
  topicIdSchema,
} from "./karte.ts";
import { planDateSchema, planSourceSchema, studyPlanDraftSchema, studyPlanSchema } from "./plan.ts";

/**
 * backend/api ↔ apps/mobile ↔ agent の契約。
 * ここを変えたら fixtures/ も更新する(fixtureはFlutter側のテストからも読まれる)。
 */

export const apiPaths = {
  createSession: "/v1/sessions",
  updateSessionTopics: (sessionId: string) => `/v1/sessions/${sessionId}/topics`,
  updateSessionProblem: (sessionId: string) => `/v1/sessions/${sessionId}/problem`,
  startSession: (sessionId: string) => `/v1/sessions/${sessionId}/start`,
  completeSession: (sessionId: string) => `/v1/sessions/${sessionId}/complete`,
  progress: "/v1/me/progress",
  reviewQueue: "/v1/me/reviews",
  answerReview: (holeId: string) => `/v1/me/reviews/${holeId}`,
  revenueCatWebhook: "/v1/webhooks/revenuecat",
  parentReport: "/v1/me/parent-report",
  createPlanSession: "/v1/plans",
  completePlanSession: (planSessionId: string) => `/v1/plans/${planSessionId}/complete`,
  plan: "/v1/me/plan",
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
 *
 * ただし動機が消えたのは契約の上だけで、しばらくのあいだUI側に残っていた。
 * アプリの撮影画面は入った瞬間に**ノートのカメラ**を開いていたので、
 * ノートが無い生徒は問題の枠を一度も見ないままシャッターの前に立ち、
 * 手元にある紙面をノート枠に入れていた。**枠を先に見せて選ばせる**ように
 * 変えて、ここも塞いである(`capture_screen.dart`)。
 * 入口を作り直すときは、**カメラを自動で開かないこと**が破棄の約束の一部だと
 * 思って扱ってください。
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
 * よってアプリは撮影の確認画面でヒントを出し、この欄では出しわけない。
 *
 * 画面側では**埋まっている枠**でヒントを選んでいる(まだ1枚も無い人には
 * 「どちらか1枚で始められる」、ノートだけ撮った人には上の促し)。これは
 * **どちらも撮る前に出る言葉**なので、ここで言う「解析後に出すと2枚目が
 * 事実上の必須になる」とは別の軸の話。
 *
 * この欄はいま**観測のため**にある。
 *
 * どれくらいの生徒が実際に2枚送るかは、この値でしか観測できない。
 *
 * `manual` は写真ではなく、生徒が自分で打ち直した問題文
 * ({@link updateSessionProblemRequestSchema})。**写真の2枠と対等に並べてある**のは、
 * 「問題文がどこから来たか」が1つの軸だから — 別の欄に分けると、
 * 「本文はあるが出どころが無い」を作れなくした {@link sessionProblemSchema} の縛りが緩む。
 * 手入力がどれくらい使われるかも、`problem_photo` と同じ物差しで読める。
 */
export const problemSources = ["problem_photo", "notes_photo", "manual"] as const;
export const problemSourceSchema = z.enum(problemSources);
export type ProblemSource = (typeof problemSources)[number];

/**
 * 写真から問題文を取り出せたか。取り出せなかったなら、**どう落ちたか**。
 *
 * サーバ内部のログ用の値だった(`backend/api` の `resolveSessionProblem`)。
 * **応答に載せたのは、落ち方ごとに直し方が違うから。**
 * `too_long` は「紙面を丸ごと撮っている」、`solution_included` は「解答が写っている」で、
 * どちらも次の一手が具体的に決まる。ぜんぶ「読み取れませんでした」に畳むと、
 * 生徒には同じ行き止まりに見え、直しようがない。
 *
 * | 値 | 何が起きたか |
 * | --- | --- |
 * | `read` | 読み取れた({@link SessionProblem} が入っている) |
 * | `not_found` | 設問が写っていない・書き起こせなかった |
 * | `too_long` | {@link problemTextMaxLength} を超えた(ページ全体を写している) |
 * | `solution_included` | 解答・解説が混ざっていた |
 * | `not_a_problem` | 式だけの断片で、何を問われているか書かれていない |
 *
 * **`read` 以外でもセッションは成立する。** ここは警告ではなく、
 * 手入力({@link updateSessionProblemRequestSchema})への案内の材料。
 */
export const problemOutcomes = [
  "read",
  "not_found",
  "too_long",
  "solution_included",
  "not_a_problem",
] as const;
export const problemOutcomeSchema = z.enum(problemOutcomes);
export type ProblemOutcome = (typeof problemOutcomes)[number];

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
    /**
     * チップに出す短い課程名。「中1」「数学I」「Algebra 2」。
     *
     * **サーバが計算して渡す。** 端末側で topic_id の接頭辞から引く作りにすると、
     * 接頭辞の対応表が4か所目になる。加えて中学英語は学年ごとに接頭辞が分かれて
     * いない(学年は表示だけの目安なので、あえて分けていない)ため、
     * 接頭辞からは「中2」を作れない。
     */
    label: z.string().min(1).max(16),
    /** 0..1。低いものは選択済みにせず、候補として並べるだけにする。 */
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type DetectedTopic = z.infer<typeof detectedTopicSchema>;

/**
 * 学校段階。**写真解析と計画の聞き取りで、見る課程を半分に絞る**ために使う。
 *
 * 端末が設定から送る。DBには持たない — 再インストールで選び直しになる代わりに、
 * マイグレーションが要らない(ADR 0007)。
 *
 * **既定は `high_school`。** これを送らない古いアプリは、今までどおり
 * 高校の課程だけを見る。
 */
export const schoolStages = ["junior_high", "high_school"] as const;
export type SchoolStage = (typeof schoolStages)[number];
export const schoolStageSchema = z.enum(schoolStages);

/**
 * POST /v1/sessions のリクエスト。
 * 写真そのものは multipart/form-data の `photo` パートで送り、
 * 残りのフィールドを `meta` パートにこのJSONで入れる。
 */
export const createSessionRequestSchema = z
  .object({
    kind: sessionKindSchema.default("new"),
    locale: localeSchema.default("ja"),
    school_stage: schoolStageSchema.default("high_school"),
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
    /** サーバが強制する上限。無料・Premiumとも、15〜20分の授業を完走できる最長20分。 */
    max_seconds: z.number().int().positive(),
    /**
     * この応答時点から、今日さらに授業を始められるか。
     * §6-3「UIに数字は一切出さない」を契約の形で守るため、残数ではなく可否だけを返す。
     */
    lesson_allowed_today: z.boolean(),
  })
  .strict();

/**
 * POST /v1/sessions のレスポンス。**写真を読んだ結果だけで、部屋の鍵は入っていない。**
 *
 * ここに `livekit` と `limits` が無いのは仕様。**1日の回数を数えるのは
 * 「写真を読んだとき」ではなく「会話が始まったとき」**にしたので
 * (`startSessionResponseSchema`)、解析の応答は枠の判定を通らない。
 *
 * トークンを解析の時点で配ると、その分け方は成立しない。**トークンを持っている =
 * いつでも会話を始められる**ので、鍵を先に渡してから「会話の開始で数える」と言っても、
 * 数える口をクライアント側に置いたのと同じことになる。だから枠の確保とトークンの発行を
 * `POST /v1/sessions/{id}/start` の1操作に束ね、この応答は**単元と問題文の読み合わせ**
 * だけを返す。
 */
export const createSessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    kind: sessionKindSchema,
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
    /**
     * `problem` がこうなった理由。**写真を読んだセッションでだけ入る**
     * (復習は写真を使わないので `null`)。
     *
     * `problem` の有無だけでは、生徒に返せる言葉が「読み取れませんでした」しか無い。
     * 落ち方が分かれば、**次の一手を名指しできる** — 紙面を丸ごと撮っているのか
     * (`too_long`)、解答まで写っているのか(`solution_included`)。
     * 値の意味は {@link problemOutcomes}。
     */
    problem_outcome: problemOutcomeSchema.nullable(),
  })
  .strict();
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

/**
 * POST /v1/sessions/{id}/start のリクエスト。
 *
 * `locale` は**エラー文言の言語**だけに使う。会話の言語はセッションに残した
 * 単元の課程で決まる(端末を英語にしただけで、日本語で撮った問題に英語で
 * 教えに来ることはない)。
 */
export const startSessionRequestSchema = z.object({ locale: localeSchema.default("ja") }).strict();
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;
export type StartSessionRequestInput = z.input<typeof startSessionRequestSchema>;

/**
 * POST /v1/sessions/{id}/start のレスポンス。**ここが「1回」を数える唯一の場所。**
 *
 * 以前は写真を読んだ時点(`POST /v1/sessions`)で今日の枠を押さえていた。
 * 原価(Vision LLM)が発生するのがそこだったからだが、そのぶん
 * **撮って単元を確かめただけの人が、会話を1度もしないまま「今日はここまで」**に
 * なっていた。生徒から見れば1回とは「先輩と話した回数」なので、数える場所を
 * ここへ移してある。
 *
 * 枠の確保とトークンの発行は**サーバ側の同じ1操作**で、順番も入れ替えられない。
 * 枠を取れなければトークンは出ないし、トークンが出たなら枠は取れている。
 * (解析だけを繰り返して原価を積む道は、`POST /v1/sessions` 側の別の上限で塞ぐ。
 * そちらは1日の授業回数よりずっと緩い、異常利用だけを止める上限。)
 *
 * **再送しても二重に数えない。** 同じセッションで2度目を呼ぶと、最初に押さえた
 * 枠のままトークンだけ出し直す(通信が切れて押し直したときのため)。
 */
export const startSessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    kind: sessionKindSchema,
    livekit: liveKitConnectionSchema,
    limits: sessionLimitsSchema,
  })
  .strict();
export type StartSessionResponse = z.infer<typeof startSessionResponseSchema>;

/**
 * PATCH /v1/sessions/{id}/topics のリクエスト。
 *
 * チップUIで外した単元を、**セッションを作り直さずに**反映する。
 * 作り直すと同じ写真をもう一度Vision LLMに通すことになり(原価が二重にかかり)、
 * 解析の回数だけを見ている上限にも二重に当たる。
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

/**
 * 返るものは作成時と同じ形(単元と問題文の読み合わせ)。
 * **ここでもトークンは出さない** — 部屋の鍵が出るのは `/start` だけ。
 */
export type UpdateSessionTopicsResponse = CreateSessionResponse;

/**
 * PATCH /v1/sessions/{id}/problem のリクエスト。
 *
 * **問題文を生徒が自分で入れ直す口。** 読めなかったとき(`problem: null`)の救済と、
 * 誤読の訂正の両方がここを通る。
 *
 * ## なぜ要るか
 *
 * 問題の写真は解析後に破棄する({@link sessionPhotoParts})ので、
 * **問題文の保存先は解析結果ひとつだけ**。読めなければ授業は
 * 「問題、読んでもらってもいい?」から始まり、**画面に見えている問題を、
 * 生徒がもう一度声で入力させられる**(外部テスターの唯一の不満だったもの)。
 * 画面には読み合わせの枠があるのに、そこから直す手が無かった。
 *
 * ## 写真の撮り直しではない
 *
 * 送るのは**テキストだけ**。同じ紙面を投げ直しても、解答が混ざる原因は
 * 「紙面のどこを写したか」なので同じものが返る(`problem-guard.ts` と同じ判断)。
 * 加えて、ここでVision LLMを回さないので**解析の枠も原価も動かない** —
 * 救済の口が上限に当たって塞がる、という裏返りが起きない。
 *
 * ## 中身は素通しにしない
 *
 * 打ち直した本文も `@ai-sensei/guardrail` の `checkProblemText()` を通す。
 * 解答を貼り付けたまま送られると、先輩は解き方を組み立てずに答えを写す —
 * **写真から来たときに塞いだ穴が、手入力の側から開く。**
 * 落ちたときは `problem_unreadable` を返す(黙って `null` に畳まない。
 * それでは「打ったのに何も変わらない」になり、この口を作った意味が消える)。
 */
export const updateSessionProblemRequestSchema = z
  .object({
    locale: localeSchema.default("ja"),
    /**
     * 生徒が打ち直した問題文。上限は写真から読んだときと同じ
     * {@link problemTextMaxLength} — 先輩に渡ったあとの扱いは同じなので、
     * 入口ごとに上限が違う理由が無い。
     */
    text: z.string().min(1).max(problemTextMaxLength),
  })
  .strict();
export type UpdateSessionProblemRequest = z.infer<typeof updateSessionProblemRequestSchema>;
export type UpdateSessionProblemRequestInput = z.input<typeof updateSessionProblemRequestSchema>;

/** 返るものは作成時と同じ形。画面はこの応答でそのまま読み合わせを描き直せる。 */
export type UpdateSessionProblemResponse = CreateSessionResponse;

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
    /**
     * 復習で**今回教え直す穴だけ**。新しいAPIは復習で1件、新規授業で `null` を送る。
     *
     * `problem_text` に穴の説明を詰める案は採らない。復習には問題の写真が無く、
     * 問題文を装うと `senpai_board.*.md` の「写っていない問題を作らない」という
     * 境界が意味を失うため。写真の事実と、前回の説明から得た観測は型でも分ける。
     *
     * 前回のカルテ全体ではなく `desc` と `evidence` だけを運ぶ。`said_well` や
     * 別の穴まで渡すと、1回1穴の復習が前回セッション全体の再講義へ広がる。
     * `topic_id` は主題を示し、実際に触れてよい前提範囲は従来どおり
     * `allowed_topic_ids` が担う。中身の照合をここへ持ち込まないのは、contract は
     * 構造と上限、照合は guardrail という依存方向を守るため。
     *
     * **欄そのものはローリングデプロイのため省略可能。** APIとagentは別々に
     * デプロイされるので、新しいagentが先に出た窓では古いAPIのmetadataにこの欄が無い。
     * `undefined` も読めるようにし、agent側で従来の板書なし会話へ縮退させる。
     */
    review_hole: z
      .object({
        topic_id: topicIdSchema,
        desc: z.string().min(1).max(200),
        evidence: z.string().max(500).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((metadata) => metadata.kind === "review" || metadata.review_hole == null, {
    message: "review でないときは review_hole を入れないでください",
    path: ["review_hole"],
  });
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
    /**
     * `kind: "review"` のセッションでのみ意味を持つ、本人の申告。
     * 省略が既定で、その場合は「埋めない」。穴が埋まるのは `"said_it"` が明示されたときだけ。
     * 接続しただけで戻ったセッション(発話ゼロ・`ended_reason: "user_left"`)では
     * この欄が立たず、穴はopenのまま残る。
     */
    review_outcome: reviewOutcomeSchema.optional(),
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
    /**
     * 10秒で答える1問。レスポンスでは必須にし、旧データの
     * `hole.quiz ?? hole.desc` はサーバ側で解決する。クライアントに分岐を
     * 持たせると、画面ごとに別の出題を見せてしまうため。
     */
    quiz: z.string().min(1).max(200),
  })
  .strict();
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

/**
 * 埋まった穴。別画面の履歴は作らず、無料の復習画面の下半分に置く
 * (埋めにいく穴 ↔ 埋めた穴)。小テストで埋めた手応えも同じ場所に積み上げる。
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
  })
  .strict();
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

/** 小テストの自己申告。サーバは正誤を採点せず、本人の二択だけを受け取る。 */
export const reviewAnswerRequestSchema = z.object({ outcome: reviewOutcomeSchema }).strict();
export type ReviewAnswerRequest = z.infer<typeof reviewAnswerRequestSchema>;

/** 自己申告の直後に、穴とホームのカウンターを更新するための応答。 */
export const reviewAnswerResponseSchema = z
  .object({ hole: holeSchema, progress: progressSchema })
  .strict();
export type ReviewAnswerResponse = z.infer<typeof reviewAnswerResponseSchema>;

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
  "fair_use_limit_reached",
  "premium_required",
  "photo_unreadable",
  /**
   * 手入力の問題文をガードレールが落とした
   * ({@link updateSessionProblemRequestSchema})。**写真の話ではない**ので
   * `photo_unreadable`(「もう一度撮ってみてください」)とは分けてある。
   */
  "problem_unreadable",
  "out_of_scope",
  "session_not_found",
  "hole_not_found",
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
        /** 再試行の目安秒数(日次上限 / rate_limited のとき)。 */
        retry_after_seconds: z.number().int().min(0).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

/* -------------------------------------------------------------------------- */
/* 計画モード                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `sessionKinds` に `plan` を足さず、計画は専用セッションとして扱う。
 *
 * 授業セッションの `kind` は D1 の CHECK 制約と {@link sessionMetadataSchema} の
 * `problem_text` / `visible_work` / `allowed_topic_ids` に結びついている。そこへ計画を混ぜるには、
 * 稼働中の `sessions` テーブルを作り直すか、授業の必須文脈をすべて任意にする必要がある。
 * 前者はデプロイ中の旧 Worker を壊し、後者は「問題を見ずに教える」を型で再び許してしまう。
 * また計画は何度も組み直して生き続けるので、授業回数・連続日数に数える性質でもない。
 * 同じ LiveKit を使うことより、寿命と集計の境界を守ることを優先して契約を分けた。
 */
export const createPlanSessionRequestSchema = z
  .object({
    locale: localeSchema.default("ja"),
    school_stage: schoolStageSchema.default("high_school"),
  })
  .strict();
export type CreatePlanSessionRequest = z.infer<typeof createPlanSessionRequestSchema>;
export type CreatePlanSessionRequestInput = z.input<typeof createPlanSessionRequestSchema>;

/** LiveKitトークンに載せる、計画モード専用の会話文脈。 */
export const planSessionMetadataSchema = z
  .object({
    plan_session_id: z.string().min(1),
    /** 授業 metadata との取り違えを、agent の入口で即座に検知する判別子。 */
    kind: z.literal("plan"),
    locale: localeSchema,
    /**
     * 学校段階。**計画に出してよい単元の範囲**。
     *
     * 授業の metadata には無い(あちらは `allowed_topic_ids` の接頭辞から
     * 課程が引けるので要らない)。計画は写真が無く範囲も決まっていないので、
     * 課程を丸ごと貼る前にどちらの段かを知る必要がある。
     *
     * **このスキーマは `.strict()`。旧 agent は未知のキーで parse に失敗する**ので、
     * デプロイは agent → API の順にすること。
     */
    school_stage: schoolStageSchema,
    max_seconds: z.number().int().positive(),
    /** LLMに相対日付を推測させないため、APIが確定したローカル日付を渡す。 */
    today: planDateSchema,
    /** 組み直しでは事実を聞き直さないため、いまの計画を会話開始時に固定して渡す。 */
    current_plan: studyPlanSchema.nullable(),
  })
  .strict();
export type PlanSessionMetadata = z.infer<typeof planSessionMetadataSchema>;

export const createPlanSessionResponseSchema = z
  .object({
    plan_session_id: z.string().min(1),
    livekit: liveKitConnectionSchema,
    /** 画面は接続前から「新規」と「組み直し」を同じ事実で判断できる。 */
    current_plan: studyPlanSchema.nullable(),
  })
  .strict();
export type CreatePlanSessionResponse = z.infer<typeof createPlanSessionResponseSchema>;

/**
 * POST /v1/plans/{id}/complete — 計画 agent が内部トークンで呼ぶ。
 * LLMが出した形は {@link studyPlanDraftSchema} のまま受け、ID・時刻・状態はAPIだけが付ける。
 */
export const completePlanSessionRequestSchema = z
  .object({
    plan: studyPlanDraftSchema,
    source: planSourceSchema,
    duration_seconds: z.number().int().min(0),
    ended_reason: z.enum(["completed", "timeout", "user_left", "error"]),
  })
  .strict();
export type CompletePlanSessionRequest = z.infer<typeof completePlanSessionRequestSchema>;

export const completePlanSessionResponseSchema = z
  .object({
    plan: studyPlanSchema,
  })
  .strict();
export type CompletePlanSessionResponse = z.infer<typeof completePlanSessionResponseSchema>;

/** GET /v1/me/plan。計画がまだ無いことはエラーではなく、最初の聞き取りへの入口。 */
export const planResponseSchema = z
  .object({
    plan: studyPlanSchema.nullable(),
  })
  .strict();
export type PlanResponse = z.infer<typeof planResponseSchema>;
