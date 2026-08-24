import { z } from "zod";
import { topicIdSchema } from "./karte.ts";

/**
 * 復習問題(practice problem)。
 *
 * **穴(`karte.ts` の `Hole`)とは別物として持つ。**両者は似て見えるが、
 * 素材も、正解の有無も、誰が正誤を決めるかも違う:
 *
 * | | 穴の `quiz` | 復習問題 |
 * | --- | --- | --- |
 * | 出題元 | 本人が説明した内容(教え返しのtranscript) | **先輩が教えた内容(板書)** |
 * | 正解 | 持たない | **持つ**(`answer`) |
 * | 正誤 | 本人が「言えた / まだ」を申告 | **AIが採点する**(`verdict`) |
 * | 埋まる条件 | `said_it` の申告で `filled` | 埋まらない。履歴に積むだけ |
 *
 * 同じテーブル・同じ型に載せると `filled` が「言えた」と「正解した」の
 * 2つの意味を持ち、`computeProgress` が出す数字がどちらなのか読めなくなる。
 * だから型ごと分けてある(ADR 0009)。
 */

/**
 * agent が板書から作る、保存前の1問。
 *
 * **`answer` が必須なのが `quiz` との最大の差。**採点(`POST /v1/me/practice/{id}`)が
 * 答え合わせをするので、正解の無い問題は保存する意味がない
 * (通知だけ飛んで、解いても何も返せない問題になる)。
 */
export const practiceProblemDraftSchema = z
  .object({
    /** 板書の主題。保存時に、そのセッションの許可集合で照合される。 */
    topic_id: topicIdSchema,
    /**
     * 問い。10秒で読める長さにする。
     * 板書に出た数値をそのまま使わない(類題であって、同じ問題の再出題ではない)。
     */
    question: z.string().min(1).max(200),
    /**
     * 正解。**生徒には返さない。**採点のためだけにサーバが持つ。
     *
     * 結果画面へ正解を出すと、間違えた生徒がその場で答えを写して終わる。
     * ⑨(不正解)の主操作が「先輩に聞く」なのはそのためで、
     * 答えを見せるとその導線が意味を失う。
     * だから {@link practiceProblemSchema}(アプリが読む形)にこの欄は無い。
     */
    answer: z.string().min(1).max(200),
  })
  .strict();
export type PracticeProblemDraft = z.infer<typeof practiceProblemDraftSchema>;

/**
 * 保存後の復習問題。**アプリが読む形なので `answer` を含まない。**
 *
 * `board_id` を持つのは材料の追跡のため。誤った問題が出たときに、
 * どの板書から作られたかを引けないと原因を追う手段が無くなる。
 */
export const practiceProblemSchema = practiceProblemDraftSchema
  .omit({ answer: true })
  .extend({
    id: z.string().min(1),
    session_id: z.string().min(1),
    /** 材料になった板書。`board_channel_log` の `board_id` と同じ値。 */
    board_id: z.string().min(1),
    created_at: z.string().datetime(),
  })
  .strict();
export type PracticeProblem = z.infer<typeof practiceProblemSchema>;

/**
 * 採点の判定。
 *
 * **`unclear` を持たせているのは、モデルの迷いを生徒の記録にしないため。**
 * 採点LLMが読み取れなかったときに `incorrect` へ倒すと、間違い扱いが
 * 通知の段数と文面に直結する(1日後に「まちがえた問題」として届く)。
 * 読めなかったのは採点側の不首尾なので、生徒の記録としては別の値にする。
 */
export const practiceVerdicts = ["correct", "incorrect", "unclear"] as const;
export const practiceVerdictSchema = z.enum(practiceVerdicts);
export type PracticeVerdict = z.infer<typeof practiceVerdictSchema>;

/**
 * 1回ぶんの解答と採点。**合否に関わらず必ず積む。**
 *
 * 変わるのは次の通知の段だけで、「正解したから履歴から消える」はやらない
 * (`practice_attempts` に残っていないと、正解した問題の再訪が
 * 「一度も解いていない問題」と区別できなくなる)。
 */
export const practiceAttemptSchema = z
  .object({
    id: z.string().min(1),
    problem_id: z.string().min(1),
    answered_at: z.string().datetime(),
    /** 生徒が書いた答え。テキスト入力なので、本人の言葉がそのまま残る。 */
    response: z.string().min(1).max(500),
    verdict: practiceVerdictSchema,
    /**
     * 採点したモデル名。
     *
     * **採点の質が落ちた期間を、後から切り分けるために残す。**
     * モデルを差し替えたあとに `incorrect` が増えたとき、これが無いと
     * 「生徒が難しく感じた」のか「採点が辛くなった」のか区別できない。
     */
    graded_by: z.string().min(1).max(100),
    /**
     * 結果画面に出す先輩の一言。
     *
     * 見出し(「言えてる」「ここ、まだだね」)だけでは、不正解のときに
     * 次の一手が出ない。画面遷移キャンバスの ⑧⑨⑩ がこの欄を前提にしている。
     * **責める文体にしない**(約束3。`incorrect` でも「ここまでは合ってる」から書く)。
     */
    comment: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type PracticeAttempt = z.infer<typeof practiceAttemptSchema>;
