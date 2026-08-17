import type { Locale } from "@ai-sensei/contract";
import {
  type CurriculumSubject,
  findTopic,
  isKnownTopicId,
  localeOfTopicId,
  prerequisitesOf,
} from "@ai-sensei/curriculum";
import { conversationPrerequisiteDepth } from "@ai-sensei/guardrail";
import {
  formatAllowedTopics,
  formatBullets,
  formatProblemText,
  formatVisibleWork,
} from "@ai-sensei/prompts";
import { type SessionContext, sessionContextSchema, subjectOf } from "../context.ts";
import { startsWithBoardLesson } from "../senpai.ts";

/**
 * 測る対象の入力。**`backend/api` が組み立てる `SessionMetadata` そのもの**を持つ。
 *
 * 「写真解析の出力を固定した体」で書いてある。ハーネスは Vision LLM を呼ばないので、
 * 写真から先の経路(問題文・ノートの読み取り・質問の種・許可トピック)は
 * ここに凍らせた値がそのまま板書プロンプトへ流れる。**プロンプトを直したときに
 * 動く数字だけを見たい**ので、入力側は試行をまたいで1ビットも変えない。
 *
 * 整形済みの文字列(`problem_text` / `visible_work` / `allowed_topics` …)は
 * **`@ai-sensei/prompts` の整形関数を通して作る**。手で書くと、空欄の
 * プレースホルダ(「(ノートの写真なし)」)が1文字ずれて、プロンプト側の分岐が
 * 発火しないまま「本番では起きない入力」を測ることになる。
 */
export type EvalScenario = {
  /** ファイル名にも入る。`<id>.<locale>.t<N>.json`。 */
  id: string;
  locale: Locale;
  /** 何を測るためのシナリオか(1行)。`eval list` に出る。 */
  description: string;
  context: SessionContext;
};

/** 試行ファイルと `run.json` のキー。**ここが唯一の綴り方。** */
export function scenarioKey(scenario: Pick<EvalScenario, "id" | "locale">): string {
  return `${scenario.id}.${scenario.locale}`;
}

type ScenarioInput = {
  id: string;
  locale: Locale;
  description: string;
  kind: SessionContext["kind"];
  /** この授業の主題。**前提は自動で足す**(下の `allowedTopicIds`)。 */
  topicIds: readonly string[];
  photoSummary: string;
  /** 読み取れた問題文。`null` は「問題の写真なし」(復習セッション)。 */
  problemText: string | null;
  /** ノートから読み取れた作業。`null` は「ノートの写真そのものが無い」。 */
  visibleWork: readonly string[] | null;
  questionSeeds: readonly string[];
  reviewHole?: NonNullable<SessionContext["review_hole"]>;
};

/**
 * 許可トピック。**主題 + 前提2段**で、`backend/api` が載せてくるものと同じ広さ
 * (`conversationPrerequisiteDepth`)。ここで狭めると、板書プロンプトが
 * 「前提に戻ってよい」と言っているのに戻ると範囲外になる授業を測ってしまう。
 */
function allowedTopicIds(topicIds: readonly string[]): string[] {
  const ids = [...topicIds];
  for (const id of topicIds) {
    for (const prerequisite of prerequisitesOf(id, conversationPrerequisiteDepth)) {
      if (!ids.includes(prerequisite.id)) ids.push(prerequisite.id);
    }
  }
  return ids;
}

/**
 * 1本ぶんの入力を、契約の形まで組み立てて凍らせる。
 *
 * **契約の検証(`sessionContextSchema` = contract の `sessionMetadataSchema`)を
 * ここで通す。**シナリオが契約から外れたら
 * モジュールの読み込みで落ちるので、テストを待たずに気づける
 * (`backend/api` の `buildSessionMetadata` が同じ場所で検証しているのと同じ理由)。
 */
function scenario(input: ScenarioInput): EvalScenario {
  const ids = allowedTopicIds(input.topicIds);
  const topics = ids.flatMap((id) => {
    const topic = findTopic(id);
    return topic === undefined ? [] : [topic];
  });

  const context = sessionContextSchema.parse({
    session_id: `ses_eval_${input.id}_${input.locale}`,
    locale: input.locale,
    kind: input.kind,
    // 15分(有料枠の上限)を持たせ、`remainingSeconds` は途中の値を渡す。
    // 授業の途中で測るのが本番に近い(残り時間が締めの判断に効く)。
    max_seconds: 900,
    photo_summary: input.photoSummary,
    problem_text: formatProblemText(input.problemText, input.locale),
    visible_work: formatVisibleWork(input.visibleWork, input.locale),
    question_seeds: formatBullets(input.questionSeeds, input.locale),
    allowed_topics: formatAllowedTopics(topics, input.locale),
    allowed_topic_ids: ids,
    is_premium: false,
    review_hole: input.reviewHole ?? null,
  });

  return { id: input.id, locale: input.locale, description: input.description, context };
}

/**
 * 組み込みシナリオ。**教科・課程・kind の組み合わせで、経路を撃ち分ける**:
 *
 *   - 数学 × ja / en … `senpai_board.{ja,en}.md` + `math_speech_hints`
 *   - 英語 × 中学 / 高校 … `senpai_board_english.ja.md`(教科で別本になる分岐)
 *   - `kind: "review"` … `review_context` の経路(写真なしで穴から始める)
 *   - 図形 … `figure` / `triangle` を誘発する題材(作図が解けるかは配送層が見る)
 *
 * **英語科目に `locale: "en"` は無い。**`promptCatalog` が
 * `senpai_board_english` と `english_speech_hints` を `["ja"]` にしているのは、
 * このアプリが「英語話者に英語を教える課程」を持たないから(カリキュラム側にも
 * `hs_english_en` は無い)。そのため英語の2本はどちらも `ja` で、代わりに
 * **中学英語と高校英語の2課程**を測る。
 */
export const evalScenarios: readonly EvalScenario[] = [
  scenario({
    id: "math_quadratic",
    locale: "ja",
    description: "中3の二次方程式。因数分解で解ける式と解の公式が要る式が並ぶ標準ケース",
    kind: "new",
    topicIds: ["J3-KAZUSHIKI-NIJI-HOTEISHIKI"],
    photoSummary:
      "ノートに二次方程式の問題が2問。(1)は因数分解の途中まで、(2)は解の公式に代入したところで止まっている。",
    problemText: "次の二次方程式を解きなさい。\n(1) x^2 - 5x + 6 = 0\n(2) x^2 - 4x - 1 = 0",
    visibleWork: [
      "(1) は (x - 2)(x - 3) = 0 まで書いて、そこで止まっている",
      "(2) は解の公式に代入して、根号の中が 20 になったところで手が止まっている",
    ],
    questionSeeds: ["因数分解で解ける形かどうかの見分け方", "根号の中が平方数でないときの扱い"],
  }),
  scenario({
    id: "math_quadratic",
    locale: "en",
    description: "同じ二次方程式を海外課程(Algebra 1)で。英語の板書プロンプト経路",
    kind: "new",
    topicIds: ["A1-QUAD-SOLVE"],
    photoSummary:
      "Two quadratic equations in the notebook. (1) is factored partway; (2) stops after substituting into the quadratic formula.",
    problemText: "Solve each equation.\n(1) x^2 - 5x + 6 = 0\n(2) x^2 - 4x - 1 = 0",
    visibleWork: [
      "(1) is written as (x - 2)(x - 3) = 0 and stops there",
      "(2) substitutes into the quadratic formula and stops with 20 under the radical",
    ],
    questionSeeds: [
      "How to tell whether an equation factors",
      "What to do when the radicand is not a perfect square",
    ],
  }),
  scenario({
    id: "english_grammar",
    locale: "ja",
    description: "中学英語の現在完了。教科の切り替え(sentence / compare の板書)を測る",
    kind: "new",
    topicIds: ["JE-JISEI-KANRYO"],
    photoSummary:
      "中学英語のワークシート。現在完了の書き換え問題で、過去形との使い分けのところで手が止まっている。",
    problemText:
      "次の文を、( ) 内の語句を使って現在完了の文に書きかえなさい。\n(1) I lost my key. (still / cannot find it)\n(2) He went to Kyoto last year. (three times)",
    visibleWork: [
      "(1) は I have lost my key. と書けている",
      "(2) は He has gone to Kyoto three times. と書いていて、been と gone を取り違えている",
    ],
    questionSeeds: ["過去形と現在完了の使い分け", "have been to と have gone to の違い"],
  }),
  scenario({
    id: "english_relative",
    locale: "ja",
    description: "高校英語(英コミュI)の関係代名詞。英語課程が2本ある側の経路",
    kind: "new",
    topicIds: ["E1-BUNPO-KANKEI-DAIMEISHI"],
    photoSummary:
      "英語コミュニケーションIの問題集。関係代名詞で2文を1文にする問題で、目的格のところで詰まっている。",
    problemText:
      "次の2文を関係代名詞を使って1文にしなさい。\n(1) I have a friend. He lives in Osaka.\n(2) This is the book. I bought it yesterday.",
    visibleWork: [
      "(1) は I have a friend who lives in Osaka. と書けている",
      "(2) は This is the book which I bought it yesterday. と、it を残したまま書いている",
    ],
    questionSeeds: ["主格と目的格の見分け方", "関係代名詞のあとに続く文の形"],
  }),
  scenario({
    id: "math_review",
    locale: "ja",
    // 復習は写真が無い。`problem_text` はプレースホルダのままで、授業の根拠は穴だけ。
    description: "復習セッション。写真なしで review_hole から板書を始める経路",
    kind: "review",
    topicIds: ["M1-NIJI-HANBETSU"],
    photoSummary: "前回、判別式の符号と実数解の個数の対応が言えなかった。",
    problemText: null,
    visibleWork: [],
    questionSeeds: ["判別式が 0 のときに何が起きているか"],
    reviewHole: {
      topic_id: "M1-NIJI-HANBETSU",
      desc: "判別式の符号と実数解の個数の対応が言えない(D > 0 と D = 0 が入れ替わる)",
      evidence: "「D が 0 より大きいときは…えっと、重解になるんでしたっけ」",
    },
  }),
  scenario({
    id: "math_figure",
    locale: "ja",
    description: "三平方の定理。figure / triangle の板書要素を誘発する図形問題",
    kind: "new",
    topicIds: ["J3-ZUKEI-SANHEIHO"],
    photoSummary:
      "ノートに直角三角形の図が写っていて、辺の長さを求める問題。図に 3cm と 4cm の書き込みがある。",
    problemText:
      "右の図の直角三角形 ABC で、∠C = 90°、AC = 3cm、BC = 4cm である。\n(1) 辺 AB の長さを求めなさい。\n(2) 点 C から辺 AB におろした垂線の長さを求めなさい。",
    visibleWork: [
      "(1) は 3^2 + 4^2 = 25 まで書いて、AB = 25 としている",
      "(2) は図に垂線を引いただけで、式は何も書いていない",
    ],
    questionSeeds: ["25 のあとに何をするか", "面積を2通りで表すという発想"],
  }),
];

export function findScenario(id: string, locale: Locale): EvalScenario | undefined {
  return evalScenarios.find((entry) => entry.id === id && entry.locale === locale);
}

export type ScenarioFilter = {
  /** シナリオid。`"all"` か省略で全部。 */
  scenario?: string;
  /** `"ja"` / `"en"` / `"all"`。省略で全部。 */
  locale?: string;
};

/**
 * 走らせる組み合わせを選ぶ。**当てはまるものが無ければ空を返す** —
 * 呼び出し側(CLI)が「そんなシナリオは無い」と名前を出して落とすため、
 * ここで例外にはしない。
 */
export function selectScenarios(filter: ScenarioFilter = {}): EvalScenario[] {
  const wantScenario = filter.scenario ?? "all";
  const wantLocale = filter.locale ?? "all";
  return evalScenarios.filter(
    (entry) =>
      (wantScenario === "all" || entry.id === wantScenario) &&
      (wantLocale === "all" || entry.locale === wantLocale),
  );
}

/**
 * シナリオの検算。**問題が無ければ空配列。**
 *
 * 見るのは「本番では起きない入力を測っていないか」の4点。どれも
 * 壊れていても板書は出てしまい、**数字だけが静かに意味を失う**:
 *
 *   1. 契約(`sessionMetadataSchema`)を通るか
 *   2. `allowed_topic_ids` がカリキュラムに**実在**するか
 *      (`topicIdSchema` は書式しか見ないので、形だけ正しい別単元は素通りする)
 *   3. 会話の言語が主題の課程と合っているか(ADR 0005 — 端末の言語では決まらない)
 *   4. `kind: "review"` なら `review_hole` があるか
 *      (無いと `startsWithBoardLesson` が偽で、本番では板書に入らない)
 *
 * プロンプトが組めるか(教科 × 言語の版があるか)はここでは見ない。
 * `run-board.ts` の `boardSystemPrompt()` を実際に呼ぶテストが見る
 * (この層に `@ai-sensei/prompts` の版の有無を二重に書くと、必ず片方が古くなる)。
 */
export function checkScenario(scenario: EvalScenario): string[] {
  const issues: string[] = [];

  const parsed = sessionContextSchema.safeParse(scenario.context);
  if (!parsed.success) issues.push(`契約に合いません: ${parsed.error.message}`);

  if (scenario.context.locale !== scenario.locale) {
    issues.push(`locale が context と食い違っています: ${scenario.context.locale}`);
  }

  const ids = scenario.context.allowed_topic_ids;
  if (ids.length === 0) {
    issues.push("allowed_topic_ids が空です(許可トピックが空のセッションは開始できません)");
  }
  for (const id of ids) {
    if (!isKnownTopicId(id)) issues.push(`カリキュラムに無い topic_id です: ${id}`);
  }

  const [primary] = ids;
  if (primary !== undefined) {
    const trackLocale = localeOfTopicId(primary);
    if (trackLocale !== undefined && trackLocale !== scenario.locale) {
      issues.push(`主題の課程の指導言語は ${trackLocale} です(locale=${scenario.locale})`);
    }
  }

  if (!startsWithBoardLesson(scenario.context)) {
    issues.push("このシナリオは板書授業に入りません(review なら review_hole が要ります)");
  }

  return issues;
}

/** そのシナリオの教科。板書に使える要素と同梱する音声ヒントを決める(ADR 0007)。 */
export function subjectOfScenario(scenario: EvalScenario): CurriculumSubject {
  return subjectOf(scenario.context);
}
