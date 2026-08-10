import { z } from "zod";
import { topicIdSchema } from "./karte.ts";

/**
 * 学習計画(計画モード)の契約。
 *
 * 入力は**会話の書き起こし**であって、画面の入力欄ではない(ピボット計画 v1 §4-3):
 *
 *   先輩「テストいつ?」        → 「9月10日」
 *   先輩「範囲は?」            → 「数IIの三角関数、教科書120〜150ページ」
 *   先輩「使ってる参考書ある?」→ 「4STEPと青チャート」
 *   先輩「じゃあ、こんな感じでどう?」→ 計画が画面に出る
 *
 * 設計上の約束:
 *
 *   - **フォームを作らない。** §1 で「学習計画をフォーム入力で作る」案は
 *     **却下されている**(価値を体験する前の摩擦が最大 → 初回離脱)。
 *     フィールドを1つ足すことは、先輩の質問を1つ増やすことと同じ。
 *     聞きたいことが増えたら、まず**聞かずに済ませられないか**を考える。
 *
 *   - **点数を出さない**(デッキ §0 の約束2)。目標点・正答率・理解度・偏差値・消化率の
 *     フィールドを持たない。`.strict()` なので後から足すとテストが落ちる。
 *     学習計画は**約束2がいちばん破られやすい場所**で、「目標80点」「今週の達成率」は
 *     計画アプリの定番。しかもこの形は §5 の親レポートに載る前提なので、
 *     ここに数字を1つ置くと**そのまま親に届く**(§5-2 の ❌ 側)。
 *
 *   - **事実と割り当てを分ける。** {@link planIntakeSchema} が聞き取った事実、
 *     `days` が生成された割り当て。組み直しは**割り当てだけを作り直す**。
 *     風邪をひいてもテスト日は動かない。ここを混ぜると、組み直しのたびに
 *     事実を聞き直すことになり、結局フォームに戻る。
 *
 *   - **持っていない教材を割り当てられない。** `material` は名前ではなく
 *     `materials` への**添字**({@link planItemDraftSchema})。
 *
 *   - **守れない計画を書けない。** 1日あたりの上限({@link planDayMinutesMax})と、
 *     テスト日を越えないこと。守れない計画は「計画は自分には無理だ」を学習させるので、
 *     上限はプロンプトのお願いではなくスキーマで持つ(`board.ts` の `speech` と同じ)。
 *
 *   - **縮退できる形にしておく。** §7「遅れたら落とす順」①で、計画の自動生成は
 *     **先輩が定型テンプレを提案するだけ**に落ちる。そのときも形は同じで、
 *     埋める人が変わるだけ({@link planSources})。
 *
 * **中身の妥当性は照合しない。** topic_id がカリキュラム内か、割り当てた単元が
 * 範囲(またはその前提)に収まっているかは `@ai-sensei/guardrail` の責務。
 * contract は依存を持たない層なので、前提関係を知らない(`karte.ts` の
 * `topicIdSchema` と同じ分担)。ここが見るのは**形と上限**だけ。
 */

/**
 * テスト日と割り当ての日。**ローカル日付**(`YYYY-MM-DD`)で、`datetime` にしない。
 *
 * 「9月10日のテスト」は生徒のカレンダー上の1日であって、時刻を持たない。
 * 瞬間(UTC)で持つと `2026-09-10T00:00:00Z` は日本の朝9時になり、
 * 端末のタイムゾーン次第で**テストが前日に動く**。`karte.ts` の
 * `last_session_date` と同じ扱いにしてある。
 *
 * この形なら**文字列の辞書順が日付順と一致する**ので、下の順序検査は素直に書ける。
 */
export const planDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** テストの呼び方(「2学期の中間」)。分類ではなく本人の言い方をそのまま入れる。 */
export const planExamNameMaxLength = 40;

/**
 * 範囲を**本人がどう言ったか**の上限。
 * 「教科書120〜150ページ」はカリキュラムの単元IDに存在しないが、
 * **生徒が実際に開くのはそのページ**なので落とせない(§5-2「本人の言葉」と同じ理由)。
 */
export const planScopeSaidMaxLength = 120;

/**
 * 範囲に入る単元数の上限。定期テストの範囲は数単元で、
 * 8を超えるなら「範囲」ではなく学期まるごと = 2週間の計画に落ちない。
 */
export const planScopeTopicsMaxCount = 8;

/** 教材名の上限(「4STEP」「青チャート」「教科書」)。 */
export const planMaterialNameMaxLength = 40;

/**
 * 教材の数の上限。高校生がテスト前に実際に手を動かすのは多くて3〜4冊。
 * ここを増やしても、増えるのは「持っているが開かない本」だけ。
 */
export const planMaterialsMaxCount = 4;

/** 1つの割り当てで何をするか(「4STEPの例題42〜50」)。 */
export const planItemWhatMaxLength = 80;

/**
 * 1つの割り当ての所要時間(分)の下限。
 * 10分未満は、取りかかる前に終わる。刻みすぎた計画は項目数だけが増えて、
 * 1日の見た目が実際より重くなる。
 */
export const planItemMinutesMin = 10;

/** 1つの割り当ての所要時間の上限。1項目60分を超えるなら、それは2つの項目。 */
export const planItemMinutesMax = 60;

/** 1日に置ける割り当ての数。 */
export const planItemsPerDayMaxCount = 3;

/**
 * **1日の合計時間の上限(分)。**
 *
 * 部活から帰ってきた高校生の平日に入るのは2時間まで。それ以上を書いた計画は守られず、
 * **守られなかった計画は「計画は自分には無理だ」だけを教える**。
 * だからこれは目安ではなく上限で、`planItemMinutesMax × planItemsPerDayMaxCount`
 * (180分)より**意図的に小さくしてある** — 上限3項目は「種類を分ける」ためであって、
 * 「3倍やらせる」ためではない。
 */
export const planDayMinutesMax = 120;

/**
 * 計画に置ける日数の上限。
 *
 * 定期テストの範囲が発表されるのは2〜3週間前で、入口の主役も週額プラン(§6-2)。
 * 35日(5週間)を超える先のテストは「今日から毎日」ではなく、
 * **近づいてから組む**もの。上限に当たるのは、たいてい生徒が言った日付を
 * 取り違えている(来年の日付として解釈した)ときなので、安全弁としても効く。
 */
export const planDaysMaxCount = 35;

/** 組み直しの履歴の上限。20回組み直した計画は、計画ではなく日記。 */
export const planRevisionsMaxCount = 20;

/**
 * 聞き取りの1ターンで喋る長さの上限({@link planTurnSchema})。
 *
 * 値も理由も `board.ts` の `boardSpeechMaxLength` と同じ(日本語TTS 約330字/分から、
 * 1ターン20〜25秒)。同じ数字を別に置いているのは、片方を動かす判断が
 * もう片方に黙って波及しないようにするため — 板書の上限は「数式を喋らせない」ための線、
 * こちらは「聞き取りを長引かせない」ための線で、動かす理由が違う。
 */
export const planSpeechMaxLength = 120;

/** 組み直しの理由として本人が言ったこと。カルテの `desc` と同じ長さに揃えてある。 */
export const planRevisionSaidMaxLength = 200;

/**
 * 誰がこの計画を組んだか。
 *
 * `template` は §7「落とす順」①の**縮退版** — 先輩が聞き取った事実に定型テンプレを
 * あてはめただけで、LLMは日単位の割り当てを作っていない。
 *
 * **これを契約に持つのは、縮退したことに気づけるようにするため。**
 * 画面はどちらも同じ計画として出す(生徒に「これは簡易版です」とは言わない)ので、
 * フィールドが無いと**縮退したまま運用に入ったことを誰も知らないまま**になる
 * (§10-7 の「依存だけ入って動いていないSentry」と同じ壊れ方)。
 */
export const planSources = ["senpai", "template"] as const;
export const planSourceSchema = z.enum(planSources);
export type PlanSource = (typeof planSources)[number];

/**
 * 割り当ての状態。**本人の自己申告**で、AIは採点しない(§2 の小テストと同じ制約)。
 *
 * `moved` は組み直しで別の日に動かしたもので、**「できなかった」ではない**。
 * 「やらなかった日」を残す形にすると、計画が責める道具になる(約束4)。
 * 動かした事実は残り、失敗としては残らない。
 *
 * **集計した割合(消化率・達成率)のフィールドは持たない。**
 * 1件ずつの事実は観測できたことだが、割合にした瞬間に点数になる(約束2)。
 */
export const planItemStatuses = ["todo", "done", "moved"] as const;
export const planItemStatusSchema = z.enum(planItemStatuses);
export type PlanItemStatus = (typeof planItemStatuses)[number];

/**
 * 組み直しの理由。**生徒の評価ではなく、計画の作り直し方の分岐**。
 *
 *   - `behind` / `ahead` … 事実は変わっていない。**割り当てだけ**を作り直す
 *   - `facts_changed` … テスト日・範囲・教材のどれかが変わった。
 *     {@link planIntakeSchema} から書き換える
 *
 * 混ぜると、遅れただけの組み直しで聞き取りをやり直すことになる(= フォームに戻る)。
 *
 * `behind` が続くのは、生徒が怠けている証拠ではなく**最初の計画が重すぎた**という観測で、
 * 次に組む計画を軽くする材料にする。責める材料にはしない(約束4)。
 */
export const planRevisionReasons = ["behind", "ahead", "facts_changed"] as const;
export const planRevisionReasonSchema = z.enum(planRevisionReasons);
export type PlanRevisionReason = (typeof planRevisionReasons)[number];

/**
 * 範囲。**単元IDと本人の言い方の両方**を持つ。
 *
 * 片方だけにすると計画が使えなくなる:
 *   - 単元IDだけ → 画面に「三角関数」とだけ出て、生徒はどのページを開くのか分からない
 *   - 本人の言葉だけ → カリキュラムと噛み合わず、穴・復習・親レポートのどれとも繋がらない
 */
export const planScopeSchema = z
  .object({
    /** 範囲の単元。カリキュラム内かは `@ai-sensei/guardrail` が照合する。 */
    topic_ids: z.array(topicIdSchema).min(1).max(planScopeTopicsMaxCount),
    /** 本人が言った範囲(「教科書120〜150ページ」)。要約せず、言ったとおりに残す。 */
    said: z.string().min(1).max(planScopeSaidMaxLength),
  })
  .strict();
export type PlanScope = z.infer<typeof planScopeSchema>;

/**
 * 聞き取った事実。**組み直しても変わらない側**。
 *
 * 聞くのはこの3つだけ(テストの日 / 範囲 / 使っている教材)。
 * ここに項目を足すと、そのぶん先輩の質問が増え、§1 で却下したフォームに近づく。
 *
 * ロケール(課程)のフィールドは持たない。ADR 0005 のとおり
 * **topic_id の接頭辞から決まる**ので、持つと二重の正になる。
 */
export const planIntakeSchema = z
  .object({
    /** テストの呼び方。「2学期の中間」。画面の見出しに出す。 */
    exam_name: z.string().min(1).max(planExamNameMaxLength),
    /** テストの日。計画の終端。 */
    exam_date: planDateSchema,
    scope: planScopeSchema,
    /**
     * 使っている教材。本人が言った名前をそのまま(訳さない・正式名称に直さない)。
     * **空でよい** —「特にない」なら教科書だけで組む。
     * 持っていない本を勧めるくらいなら、教材なしの計画のほうが実行される。
     */
    materials: z.array(z.string().min(1).max(planMaterialNameMaxLength)).max(planMaterialsMaxCount),
  })
  .strict();
export type PlanIntake = z.infer<typeof planIntakeSchema>;

/**
 * 1件の割り当て(生成される側)。
 *
 * `material` を**名前ではなく添字**にしてあるのが要点。文字列で持たせると、
 * LLMは「青チャートの例題42」を、青チャートを持っていない生徒に割り当てられる。
 * 添字なら、**聞き取った教材の外を指すことがスキーマとして不可能**になる
 * (`board.ts` の `angleMark.vertex` が頂点を添字で指すのと同じ手)。
 * 上限は `intake.materials` の長さに依るので、検査は {@link studyPlanDraftSchema} 側。
 */
export const planItemDraftSchema = z
  .object({
    /** どの単元か。範囲(またはその前提)の中かは `@ai-sensei/guardrail` が照合する。 */
    topic_id: topicIdSchema,
    /** 何をするか、一行。「4STEPの例題42〜50」「加法定理を導出しながらノートに書く」。 */
    what: z.string().min(1).max(planItemWhatMaxLength),
    /** `intake.materials` の添字。`null` は教材を使わない項目(ノートの見直しなど)。 */
    material: z.number().int().min(0).nullable(),
    /**
     * 目安の時間(分)。**予定であって実績ではない。**
     * 実際にやった時間のフィールドを持たないのは意図で、持つと「今週◯時間」が
     * 親レポートに出て、§5-2 の ❌「学習時間ランキング」まで一歩で届く。
     */
    minutes: z.number().int().min(planItemMinutesMin).max(planItemMinutesMax),
  })
  .strict();
export type PlanItemDraft = z.infer<typeof planItemDraftSchema>;

/** 保存後の割り当て。自己申告の状態が付く({@link planItemStatuses})。 */
export const planItemSchema = planItemDraftSchema.extend({ status: planItemStatusSchema }).strict();
export type PlanItem = z.infer<typeof planItemSchema>;

/**
 * 1日ぶん。
 *
 * **`items` が空の日を許すのは、休む日を明示的に置くため。**
 * 配列に無い日(= 何も書かれていない日)は計画の対象外だが、
 * 配列にあって空の日は「ここは休もう」と先輩が置いた日で、意味が違う。
 * 休みの入っていない計画は、最初に崩れた日に丸ごと捨てられる。
 */
export const planDayDraftSchema = z
  .object({
    date: planDateSchema,
    items: z.array(planItemDraftSchema).max(planItemsPerDayMaxCount),
  })
  .strict();
export type PlanDayDraft = z.infer<typeof planDayDraftSchema>;

export const planDaySchema = z
  .object({
    date: planDateSchema,
    items: z.array(planItemSchema).max(planItemsPerDayMaxCount),
  })
  .strict();
export type PlanDay = z.infer<typeof planDaySchema>;

/**
 * 組み直しの記録。**残すのは「組み直した事実と本人の言葉」だけ**で、
 * 前の割り当ては残さない。両方を持つと「先週の予定」と「今週の予定」が画面に並び、
 * どちらをやればいいのか分からなくなる。
 */
export const planRevisionDraftSchema = z
  .object({
    reason: planRevisionReasonSchema,
    /**
     * 本人が言ったこと(「風邪ひいて3日できなかった」)。
     *
     * **言っていないなら `null`。でっち上げない。** §5-2 で親レポートに載せてよいものの
     * 筆頭が「本人の説明の引用」で、ここは**そのまま親に届く**。
     * 縮退版(`template`)やアプリ側の判断で組み直した場合は、引用が無いのが正しい。
     */
    said: z.string().min(1).max(planRevisionSaidMaxLength).nullable(),
  })
  .strict();
export type PlanRevisionDraft = z.infer<typeof planRevisionDraftSchema>;

export const planRevisionSchema = planRevisionDraftSchema
  .extend({
    /**
     * 組み直した瞬間。ここだけ `datetime` なのは、これが暦の1日ではなく
     * **並べ替えの要る出来事**だから(1日に2回組み直すことがある)。
     *
     * draft に入っていないのは、**LLMが今が何時かを知らない**から。
     * 知らないものを出させると幻覚した時刻がそのまま履歴に残る(`id` と同じ理由)。
     */
    at: z.string().datetime(),
  })
  .strict();
export type PlanRevision = z.infer<typeof planRevisionSchema>;

/**
 * 計画そのものの不変条件。draft(LLMが出す形)と保存後で**同じ検査**をかける。
 *
 * `.superRefine()` は JSON Schema に何も残らないので、Dart側は手で入れることになる。
 * README「JSON Schema に現れない不変条件」に一覧がある。
 */
type PlanShape = {
  intake: { exam_date: string; materials: string[] };
  days: { date: string; items: { material: number | null; minutes: number }[] }[];
};

function checkPlanShape(plan: PlanShape, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  const materialCount = plan.intake.materials.length;
  let previousDate: string | null = null;

  plan.days.forEach((day, position) => {
    // 日付は昇順で、重複しない。同じ日が2回出ると、画面にその日が二重に並び、
    // どちらが正なのかを決める根拠がどこにもない。
    // `YYYY-MM-DD` は辞書順 = 日付順(planDateSchema)。
    if (previousDate !== null && day.date <= previousDate) {
      issue(`日付は昇順で、同じ日を2回置かないでください(${previousDate} のあとに ${day.date})`, [
        "days",
        position,
        "date",
      ]);
    }
    previousDate = day.date;

    // テスト当日までが計画。終わったあとの日に課題を置いても、誰もやらない。
    // (下限は縛れない。組み直した計画は `created_at` より後から始まるので、
    //  「今日より前の日を置かない」は agent 側の責務。)
    if (day.date > plan.intake.exam_date) {
      issue(`テスト日(${plan.intake.exam_date})より後の日には置けません`, [
        "days",
        position,
        "date",
      ]);
    }

    const total = day.items.reduce((sum, item) => sum + item.minutes, 0);
    if (total > planDayMinutesMax) {
      issue(`1日は合計${planDayMinutesMax}分までです(${total}分)`, ["days", position, "items"]);
    }

    day.items.forEach((item, index) => {
      // 聞き取っていない教材は割り当てられない(添字がそもそも存在しない)。
      if (item.material !== null && item.material >= materialCount) {
        issue("聞き取っていない教材は割り当てられません", [
          "days",
          position,
          "items",
          index,
          "material",
        ]);
      }
    });
  });
}

/**
 * LLMが出す形 — **聞き取った事実 + 割り当て**。
 *
 * `id` / `created_at` / `source` / `revisions` を持たないのは意図。識別子と来歴は
 * 保存側が付ける(`board.ts` で封筒と分けたのと同じ理由 — 幻覚したIDが下流に流れ込む)。
 *
 * **このスキーマは縮退版でも埋まる。** テスト日・範囲・教材は聞き取りの結果、
 * `what` と `minutes` は定型テンプレでも書ける({@link planSources} の `template`)。
 * LLMにしか埋められないフィールドを作らないことが、§7 の「落とす順」①を
 * 実際に落とせる状態に保つ条件になっている。
 */
export const studyPlanDraftSchema = z
  .object({
    intake: planIntakeSchema,
    days: z.array(planDayDraftSchema).min(1).max(planDaysMaxCount),
    /**
     * 組み直しなら、その理由と本人の言葉。**初めて組む計画では `null`。**
     *
     * ここをLLMに出させるのは、**本人の言葉を聞いているのがLLMしかいない**から。
     * agent が書き起こしから後付けで分類すると、引用を作文することになる
     * (それは §5-2 で親に届く一行なので、いちばんやってはいけない)。
     * 保存側はこれに時刻を押して `revisions` の末尾に足す。
     */
    revision: planRevisionDraftSchema.nullable(),
  })
  .strict()
  .superRefine(checkPlanShape);
export type StudyPlanDraft = z.infer<typeof studyPlanDraftSchema>;

/**
 * **計画モードでLLMが出す形。**聞き取りの1ターンぶん。
 *
 * 計画は会話の途中で生まれる(§4-3)。「テストいつ?」を喋る回と、
 * 「じゃあ、こんな感じでどう?」と言いながら計画を出す回は、**同じ形の1ターン**で、
 * 違いは `plan` が入っているかどうかだけ。
 * `{speech, board}` で1手順を表す `board.ts` の `boardStepSchema` と同じ組み方にしてある。
 *
 * こうしておくと、agent は聞き取り中と生成時でLLMの呼び方を変えなくてよく、
 * ユーザーはいつでも割り込める(計画が出るまで黙って待たされる区間がない)。
 *
 * 板書は持たない。計画モードで画面に出るのは**計画そのもの**で、
 * ここに板書を足すと「計画の説明を板書に書く」ができてしまい、聞き取りが授業になる。
 */
export const planTurnSchema = z
  .object({
    /**
     * 読み上げる文。聞くことは1ターンに1つ({@link planSpeechMaxLength})。
     *
     * `board.ts` の `speech` と違ってLaTeXの禁止を持たないのは、
     * 計画モードには**数式の置き場そのものが無い**から。禁止すると
     * 「じゃあ数式はどこに置くのか」の答えが無い指示になる。
     */
    speech: z.string().min(1).max(planSpeechMaxLength),
    /**
     * できあがった計画。**まだ聞いている途中なら `null`。**
     *
     * 途中でも毎回「いまのところの計画」を出させることはしない。
     * 事実が半分しか揃っていない計画を画面に出すと、生徒はそれを見て
     * 「もう決まったんだ」と受け取る。計画が出る瞬間は1回でいい。
     */
    plan: studyPlanDraftSchema.nullable(),
  })
  .strict();
export type PlanTurn = z.infer<typeof planTurnSchema>;

/**
 * 保存後の計画。計画画面と(将来の)親レポートが読むかたち。
 *
 * `session_id` を持たない。カルテは1セッションの出力だが、
 * **計画は何回かのセッションをまたいで生き続ける**(組み直しは別の日の別のセッションで起きる)。
 * どのセッションで生まれたかは、計画の性質ではない。
 *
 * `days` は**いまの計画**で、組み直すと置き換わる。過去の割り当ては残さない
 * (理由は {@link planRevisionSchema})。
 */
export const studyPlanSchema = z
  .object({
    id: z.string().min(1),
    created_at: z.string().datetime(),
    source: planSourceSchema,
    intake: planIntakeSchema,
    days: z.array(planDaySchema).min(1).max(planDaysMaxCount),
    /**
     * 古い順。空 = 一度も組み直していない。
     * 1回の組み直し({@link studyPlanDraftSchema} の `revision`)が末尾に1件積まれる。
     */
    revisions: z.array(planRevisionSchema).max(planRevisionsMaxCount),
  })
  .strict()
  .superRefine(checkPlanShape);
export type StudyPlan = z.infer<typeof studyPlanSchema>;
