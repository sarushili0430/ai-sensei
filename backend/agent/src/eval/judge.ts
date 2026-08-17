import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { formatTranscript } from "@ai-sensei/prompts";
import { z } from "zod";
import { type LlmClient, createAnthropicClient, extractJson } from "../karte.ts";
import { asksForTeachBack, lessonSteps, renderLessonRecap } from "../senpai.ts";
import type { EvalEnv } from "./env.ts";
import {
  type Rubric,
  type RubricSubject,
  amendmentNote,
  applicableRubrics,
  renderRubrics,
  rubricSkipReason,
  rubrics,
} from "./rubrics.ts";
import { type EvalScenario, findScenario, scenarioKey } from "./scenario.ts";
import { type TrialRecord, loadTrials, saveTrial } from "./trial.ts";

/**
 * LLMジャッジ。**字面では測れない約束**を、記録を読ませて判定する。
 *
 * `score.ts` が数えられるのは字数・件数・最終手順の形まで。`prompts/README.md` で
 * 「コード側の相手が無い」と書いてある約束(いちばん重いのが「先に答えを埋めない」)は
 * **ターンの順序**で決まるので、正規表現では原理的に置き換えられない。そこだけを
 * ここが見る。
 *
 * 作りの約束は3つ:
 *
 *   1. **1試行 = `complete()` 1回。**ルールごとに呼び分けない(7倍払って、
 *      ルール間で矛盾した読みが混ざる)。JSONで全ルールまとめて返させる。
 *   2. **判定できないルールはモデルに聞かない。**`rubrics.ts` の
 *      `rubricSkipReason` で先に落とし、`not_applicable` を**こちらで**書く。
 *      生徒の発話が無い記録で「先に埋めたか」を聞けば、教えた事実を根拠に
 *      fail が返ってくる(それはモデルの成績ではなく、問いの立て方の誤り)。
 *   3. **読めない応答はモデルの成績にしない。**パースできなければ1回だけ聞き直し、
 *      それでも読めなければ `verdict: "error"` として残す。fail と混ぜると
 *      通信の失敗やJSONの崩れがプロンプトの成績に化ける
 *      (`run-board.ts` の `record.error` と同じ切り分け)。
 *
 * ジャッジのプロンプトは**日本語だけ**。記録が英語でも基準は同じ日本語の
 * ルーブリックで、`verdict` はリテラル固定なので言語混在の影響を受けない。
 */

export const judgeSchemaVersion = 1;

/**
 * 判定の語。**`error` はモデルには渡さない**(こちらが付ける札で、
 * 「読めなかった」を意味する)。モデルが返せるのは前の3つだけ。
 */
export const judgeVerdicts = ["pass", "fail", "not_applicable", "error"] as const;
export const judgeVerdictSchema = z.enum(judgeVerdicts);
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export const ruleJudgeSchema = z
  .object({
    rule_id: z.string().min(1),
    verdict: judgeVerdictSchema,
    /** 根拠にした発話の引用。pass では空のことが普通。 */
    evidence: z.string(),
    reason: z.string(),
  })
  .strict();
export type RuleJudge = z.infer<typeof ruleJudgeSchema>;

/**
 * 検出器との食い違い。**ハーネスのチューニング用の一次データ。**
 *
 * `asksForTeachBack()` は「授業の往復を終える唯一の合図」を文言の族で見ている。
 * 取りこぼすと授業ループは渡し忘れと誤読して1パスで教え返しへ落ち、
 * 板書が最初の数行で止まる(`senpai.ts` の判定に書いてある壊れ方そのもの)。
 * 逆に拾いすぎると、途中の問いかけで授業が打ち切られる。
 *
 * どちらの向きも、**人が記録を読み比べないと見つからない**。ジャッジに
 * 「合図だと読めた発話」を引用させて突き合わせておけば、文言の族を広げる/狭める
 * 判断が試行のJSONの中に溜まる。
 */
export const detectorMismatchSchema = z
  .object({
    /**
     * `judge_only` … ジャッジは合図と読んだが `asksForTeachBack()` は偽 = **取りこぼしの候補**
     * `detector_only` … 検出器は真だがジャッジは挙げなかった = **拾いすぎの候補**
     *
     * どちらも「候補」でしかない。ジャッジが読み過ぎていることもあるので、
     * **どちらが誤りかは引用を読んだ人が決める**(自動で文言の族を動かす材料ではない)。
     */
    direction: z.enum(["judge_only", "detector_only"]),
    speech: z.string(),
    /** 手順の `index`。記録の手順に結びつけられなかった引用には無い。 */
    step_index: z.number().int().min(0).optional(),
  })
  .strict();
export type DetectorMismatch = z.infer<typeof detectorMismatchSchema>;

export const trialJudgeSchema = z
  .object({
    schema_version: z.literal(judgeSchemaVersion),
    /** ジャッジのモデル名。呼び出し側が渡さなければ欄を出さない。 */
    model: z.string().min(1).optional(),
    judged_at: z.string().min(1),
    /** {@link rubrics} の**全ルール**が、その並びで入る(レポートの列がそろう)。 */
    rules: z.array(ruleJudgeSchema),
    /** ジャッジが「教え返しの合図」と読んだ先輩の発話。突き合わせの生データ。 */
    teach_back_signals: z.array(z.string()),
    detector_mismatches: z.array(detectorMismatchSchema),
    /** 応答が読めなかったときの1行。**あるときは判定そのものが無い。** */
    error: z.string().optional(),
  })
  .strict();
export type TrialJudge = z.infer<typeof trialJudgeSchema>;

/**
 * モデルの応答。**厳しく縛らない。**
 *
 * `.strict()` にすると、余分な欄が1つ付いただけで読み直し(実LLMの支払い1回)に
 * なる。zod は既定で知らない欄を落とすので、必要な形だけを見る。
 * `verdict` を `z.string()` で受けるのも同じ理由 — 大文字や "n/a" で
 * 聞き直しを買わない({@link normalizeVerdict})。
 */
const judgeReplySchema = z.object({
  rules: z.array(
    z.object({
      rule_id: z.string(),
      verdict: z.string(),
      evidence: z.string().optional(),
      reason: z.string().optional(),
    }),
  ),
  teach_back_signals: z.array(z.string()).optional(),
});
type JudgeReply = z.infer<typeof judgeReplySchema>;

/** ジャッジ1回の上限。7ルール分の理由と引用が入る長さ(実測は500〜900トークン)。 */
export const judgeMaxTokens = 2000;

/** レコードに残す引用・理由の上限。長い引用で試行のJSONが膨らむのを防ぐだけ。 */
export const judgeTextMaxLength = 400;

/**
 * ジャッジに渡す記録の上限(文字)。
 *
 * 溢れたときは**先頭と末尾の両方を残して中を落とす**。R1(順序)の材料は
 * 授業の入り口側に、R5(受け渡し)の材料は終わり側にあるので、片側を落とすと
 * どちらかのルールが判定できなくなる。板書1枚は最大40手順なので、
 * 実際の試行でここに当たるのは往復の多いL2だけ。
 */
export const judgeTranscriptMaxLength = 20_000;

/** カルテの貼り付けの上限。5穴 × 200字 + 言えたこと10件でも収まる。 */
const judgeKarteMaxLength = 4_000;

/** 評価用のジャッジクライアント。**`@anthropic-ai/sdk` は使わない**(karte.ts の素のfetch)。 */
export function createJudgeLlm(env: EvalEnv, model: string = env.judgeModel): LlmClient {
  return createAnthropicClient({
    apiKey: env.apiKey,
    model,
    ...(env.baseUrl === undefined ? {} : { baseUrl: env.baseUrl }),
  });
}

export type JudgeTrialOptions = {
  llm: LlmClient;
  /** 問題文・許可された話題の出どころ。R6(逸脱)はこれが無いと判定できない。 */
  scenario: EvalScenario;
  /** レコードに残すモデル名。`LlmClient` は自分のモデル名を持たないので外から渡す。 */
  model?: string;
  /** 時刻の注入。テストを決定的にするためだけの穴(`run-board.ts` と同じ)。 */
  now?: () => number;
};

/**
 * 1試行を判定する。**例外を投げない**(読めない応答は `verdict: "error"` で残す)。
 *
 * 直列で回す `judgeRun` が1本の失敗で止まらないようにするため。投げて上へ返すと、
 * その run のそれ以降が判定されないまま終わる。
 */
export async function judgeTrial(
  record: TrialRecord,
  options: JudgeTrialOptions,
): Promise<TrialJudge> {
  const { llm, scenario, model, now = Date.now } = options;
  const subject: RubricSubject = {
    stage: record.meta.stage,
    // カルテ生成が失敗した試行は `{error: "..."}` の形で残る(`run-loop.ts`)。
    // それをR7(カルテの接地)に掛けると、穴が1つも無いことを違反として裁く —
    // 生成の失敗はハーネス寄りの事故で、プロンプトの成績ではない。判定対象から外す。
    hasKarte: hasJudgeableKarte(record.karte),
  };

  const asked = await askJudge(llm, {
    system: judgeSystemPrompt(applicableRubrics(subject)),
    user: judgeUserMessage(record, scenario),
  });

  const signals = (asked.reply?.teach_back_signals ?? []).filter(
    (signal) => signal.trim().length > 0,
  );

  return trialJudgeSchema.parse({
    schema_version: judgeSchemaVersion,
    ...(model === undefined ? {} : { model }),
    judged_at: new Date(now()).toISOString(),
    rules: rubrics.map((rubric) => verdictOf(rubric, subject, asked)),
    teach_back_signals: signals.map((signal) => clip(signal)),
    // **応答が読めなかったときは突き合わせをしない。**引用がゼロなのは
    // 「ジャッジが合図を1つも見つけなかった」ではなく「聞けていない」で、
    // そのまま計算すると本物の合図が全部 `detector_only` に化ける。
    detector_mismatches: asked.reply === undefined ? [] : detectorMismatches(record, signals),
    ...(asked.error === undefined ? {} : { error: asked.error }),
  });
}

type AskResult = { reply?: JudgeReply; error?: string };

/**
 * ジャッジを呼ぶ。**読めなければ1回だけ聞き直す。**
 *
 * 聞き直しは同じプロンプトで投げる。「JSONだけ返して」と足す作りにすると、
 * 2回目だけ入力が違う = 同じ試行を別の条件で測ったことになり、どちらの結果を
 * 記録したのかが後から分からなくなる。
 */
async function askJudge(
  llm: LlmClient,
  input: { system: string; user: string },
): Promise<AskResult> {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await llm.complete({ ...input, maxTokens: judgeMaxTokens });
      return { reply: judgeReplySchema.parse(extractJson(raw)) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { error: `ジャッジの応答が読めませんでした(2回): ${clip(lastError)}` };
}

/** ルール1本の判定。**判定できないもの・聞けなかったものを混ぜない。** */
function verdictOf(rubric: Rubric, subject: RubricSubject, asked: AskResult): RuleJudge {
  const skip = rubricSkipReason(rubric, subject);
  if (skip !== undefined) {
    return { rule_id: rubric.id, verdict: "not_applicable", evidence: "", reason: skip };
  }
  if (asked.reply === undefined) {
    return { rule_id: rubric.id, verdict: "error", evidence: "", reason: asked.error ?? "" };
  }

  // `rule_id` で引く。呼び名(R1)で返してくるモデルもあるので、そちらも受ける。
  const entry = asked.reply.rules.find(
    (rule) => rule.rule_id === rubric.id || rule.rule_id === rubric.code,
  );
  if (entry === undefined) {
    return {
      rule_id: rubric.id,
      verdict: "error",
      evidence: "",
      reason: "ジャッジがこのルールの判定を返しませんでした",
    };
  }

  const verdict = normalizeVerdict(entry.verdict);
  if (verdict === undefined) {
    return {
      rule_id: rubric.id,
      verdict: "error",
      evidence: clip(entry.evidence ?? ""),
      reason: `判定の語が読めません: ${clip(entry.verdict)}`,
    };
  }

  return {
    rule_id: rubric.id,
    verdict,
    evidence: clip(entry.evidence ?? ""),
    reason: clip(entry.reason ?? ""),
  };
}

/**
 * 判定の語をそろえる。**`error` は受けない**(あれはこちらの札)。
 *
 * 大文字・前後の空白・"n/a" のような書き方の揺れで聞き直しを買わないため。
 * 語そのものが違うときは `undefined` を返して `error` に落とす — 勝手に
 * pass へ寄せると、読めなかった応答が成績に化ける。
 */
export function normalizeVerdict(raw: string): Exclude<JudgeVerdict, "error"> | undefined {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");
  if (normalized === "pass") return "pass";
  if (normalized === "fail") return "fail";
  if (normalized === "not_applicable" || normalized === "n_a" || normalized === "na") {
    return "not_applicable";
  }
  return undefined;
}

/** 引用符と空白を落とした形。引用の突き合わせは**この形の包含**で見る。 */
const quoteNoise = /[\s「」『』“”"'`。、,.]/gu;

function normalizeQuote(text: string): string {
  return text.replace(quoteNoise, "");
}

/**
 * ジャッジの読みと `asksForTeachBack()` の食い違い(両方向)。
 *
 * 検出器に当てるのは、引用に対応する**手順の発話**(それが本番で判定に渡る文字列)。
 * 対応する手順が見つからない引用(言い換え・教え返しの会話からの引用)にだけ、
 * 引用そのものを当てる — どちらの向きに食い違ったかは、それでも決まる。
 */
export function detectorMismatches(
  record: TrialRecord,
  signals: readonly string[],
): DetectorMismatch[] {
  const locale: CurriculumLocale = record.meta.locale;
  const steps = lessonSteps(record.turns);
  const mismatches: DetectorMismatch[] = [];
  const cited = new Set<number>();

  for (const signal of signals) {
    const at = steps.findIndex(
      (step, index) => !cited.has(index) && quoteHits(step.speech, signal),
    );
    const step = at === -1 ? undefined : steps[at];
    if (at !== -1) cited.add(at);
    if (asksForTeachBack(step?.speech ?? signal, locale)) continue;
    mismatches.push({
      direction: "judge_only",
      speech: clip(step?.speech ?? signal),
      ...(step === undefined ? {} : { step_index: step.index }),
    });
  }

  for (const [index, step] of steps.entries()) {
    if (cited.has(index)) continue;
    if (!asksForTeachBack(step.speech, locale)) continue;
    mismatches.push({
      direction: "detector_only",
      speech: clip(step.speech),
      step_index: step.index,
    });
  }

  return mismatches;
}

/** 引用が手順の発話を指しているか。**短すぎる引用は当てない**(どこにでも当たる)。 */
function quoteHits(speech: string, quote: string): boolean {
  const left = normalizeQuote(speech);
  const right = normalizeQuote(quote);
  if (left.length === 0 || right.length < 2) return false;
  return left.includes(right) || right.includes(left);
}

/**
 * ジャッジのsystemプロンプト。
 *
 * **先輩に渡したプロンプト本文(`record.system_prompt`)は渡さない。**渡すと
 * ジャッジは「プロンプトに書いてあるか」で裁きはじめ、プロンプトを直すたびに
 * 基準が動く物差しになる(改善を測る道具にならない)。同じ理由で `metrics` も
 * 見せない — 数字を先に見せると、それに合う理由づけが返ってくる。
 */
export function judgeSystemPrompt(list: readonly Rubric[] = rubrics): string {
  return [
    "あなたは、家庭教師AI「先輩」の授業の記録を読む審査員です。ルーブリックに沿った判定だけを返してください。",
    "",
    "## 判定の前提",
    "",
    amendmentNote,
    "",
    "- 見るのは**記録に起きたこと**だけです。先輩に渡したプロンプトは渡しません(そこに書いてあるかではなく、記録がルーブリックを満たすかを見てください)。",
    "- 記録の行は `T<通し番号> <手順の番号>. 「先輩の発話」 / 板書: <板書の中身>` の形です。**順序は `T` の番号**で読んでください(手順の番号は授業のパスごとに1へ戻ります)。生徒の発話は `ユーザー:` / `Student:` の行です。",
    "- 記録が英語のこともあります。**基準はこの日本語のルーブリック**で、記録の言語では変えません。",
    "- 引用は記録にある文字列を**そのまま**写してください(要約・言い換えをしない)。",
    "",
    "## ルーブリック",
    "",
    renderRubrics(list),
    "",
    "## 返し方",
    "",
    "JSONだけを返してください。前後に説明を書かないでください。",
    "",
    "```json",
    "{",
    '  "rules": [',
    '    { "rule_id": "<ルーブリックの rule_id>", "verdict": "pass", "evidence": "根拠にした発話の引用", "reason": "その判定にした理由。1〜2文" }',
    "  ],",
    '  "teach_back_signals": ["教え返しへ渡す合図だと読めた先輩の発話の引用"]',
    "}",
    "```",
    "",
    `- \`rules\` は上のルーブリックの \`rule_id\` を**1件ずつ全部**返してください(${list.length}件)。`,
    '- `verdict` は "pass" / "fail" / "not_applicable" のどれかだけです。判定の材料が記録に無いときだけ "not_applicable" にしてください。',
    "- `evidence` は根拠にした発話の引用です。引用するものが無ければ空文字にしてください。",
    "- `teach_back_signals` は、ルールの判定とは**別に必ず**返してください。先輩の発話のうち",
    "  「ここで生徒に自分の言葉で説明させようとしている」と読めたものを、記録の `T` の行の引用符の中から",
    "  そのまま写します。1つも無ければ空配列にしてください。",
  ].join("\n");
}

/** ジャッジに渡す材料。**入力(先輩が見ていたもの) → 記録 → 教え返し → カルテ**の順。 */
export function judgeUserMessage(record: TrialRecord, scenario: EvalScenario): string {
  const context = scenario.context;
  const hole = context.review_hole;

  return [
    "## 授業の入力(先輩が見ていたもの)",
    "",
    `写真から読み取れたこと: ${context.photo_summary}`,
    "",
    "問題文:",
    context.problem_text,
    "",
    "ノートから読み取れた作業:",
    context.visible_work,
    "",
    "許可された話題:",
    context.allowed_topics,
    ...(hole === null || hole === undefined
      ? []
      : [
          "",
          `復習の対象になった詰まり: ${hole.desc}`,
          `そのときの発話: ${hole.evidence ?? "(なし)"}`,
        ]),
    "",
    `## 授業の記録(${record.meta.stage === "board" ? "板書1パス" : "授業の往復"})`,
    "",
    renderJudgeTranscript(record),
    "",
    "## 教え返しの会話",
    "",
    renderTeachBack(record),
    "",
    "## カルテ",
    "",
    renderKarte(record),
  ].join("\n");
}

/**
 * 記録を1ターン1行で書き下す。**通し番号(`T1`)を振る。**
 *
 * 手順の `index` はパスごとに0へ戻る(`senpai.ts` の続きの指示が「indexは0から」と
 * 縛っている)。順序そのものが R1 の判定材料なので、番号が巻き戻る列を渡すと
 * 「あとに言った」が読めなくなる。
 *
 * 板書の書き下し(`板書: ...`)は `renderLessonRecap` に任せる。同じ表を
 * こちらに写すと、板書の要素が1つ増えたときにジャッジ側だけが
 * 「図」の一言に畳んだ記録を読むことになる。
 */
export function renderJudgeTranscript(record: TrialRecord): string {
  const locale: CurriculumLocale = record.meta.locale;
  const lines = record.turns.map(
    (turn, index) => `T${index + 1} ${renderLessonRecap([turn], locale, judgeTranscriptMaxLength)}`,
  );
  if (lines.length === 0) return "(手順が1つも出ていません)";
  return withinBudget(lines, judgeTranscriptMaxLength).join("\n");
}

/** 先頭と末尾の両方を残して中を落とす。理由は {@link judgeTranscriptMaxLength}。 */
function withinBudget(lines: readonly string[], maxLength: number): string[] {
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= maxLength) return [...lines];

  const half = Math.floor(maxLength / 2);
  const head: string[] = [];
  let headLength = 0;
  for (const line of lines) {
    if (headLength + line.length + 1 > half) break;
    head.push(line);
    headLength += line.length + 1;
  }

  const tail: string[] = [];
  let tailLength = 0;
  for (const line of [...lines].reverse()) {
    if (head.length + tail.length >= lines.length) break;
    if (tailLength + line.length + 1 > half) break;
    tail.unshift(line);
    tailLength += line.length + 1;
  }

  return [...head, `(中略: ${lines.length - head.length - tail.length} 行)`, ...tail];
}

/**
 * 教え返しの会話。ロール名は `formatTranscript` から貰う。
 *
 * 「先輩 / ユーザー」の綴りをここに書くと、カルテを書くLLMが読む transcript と
 * 別の呼び名でジャッジに渡ることになる(`prompts/render.ts` の `roleLabels` の
 * コメントにある壊れ方 — 誰が誰に教えていたかが逆に読める)。
 */
function renderTeachBack(record: TrialRecord): string {
  const messages = (record.teach_back?.messages ?? []).map((message) => ({
    role: message.role === "senpai" ? "assistant" : "user",
    text: message.text,
  }));
  return formatTranscript(messages, record.meta.locale);
}

function renderKarte(record: TrialRecord): string {
  if (record.karte === undefined || record.karte === null) return "(なし)";
  return clip(JSON.stringify(record.karte, null, 2), judgeKarteMaxLength);
}

function clip(text: string, maxLength: number = judgeTextMaxLength): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** レコードに残っている判定。**読めない判定は「無い」**として扱う(下の `judgeRun`)。 */
/** R7に掛けてよいカルテか。`{error}` はカルテではなく「作れなかった」の記録。 */
export function hasJudgeableKarte(karte: TrialRecord["karte"]): boolean {
  if (karte === undefined || karte === null) return false;
  return !(typeof karte === "object" && "error" in (karte as Record<string, unknown>));
}

export function readTrialJudge(record: TrialRecord): TrialJudge | undefined {
  const parsed = trialJudgeSchema.safeParse(record.judge);
  return parsed.success ? parsed.data : undefined;
}

/** verdict の数。レポートの集計とジャッジの進捗行が同じ数え方を使う。 */
export function countVerdicts(judge: TrialJudge): Record<JudgeVerdict, number> {
  const counts: Record<JudgeVerdict, number> = { pass: 0, fail: 0, not_applicable: 0, error: 0 };
  for (const rule of judge.rules) counts[rule.verdict] += 1;
  return counts;
}

export type JudgeRunOptions = {
  llm: LlmClient;
  /** レコードに残すモデル名(CLIは `env.judgeModel` を渡す)。 */
  model?: string;
  /** 進捗の受け皿。CLIは1行ずつ stderr へ出す(`run` の進捗と同じ形)。 */
  onProgress?: (line: string) => void;
  now?: () => number;
};

export type JudgeRunResult = {
  runDir: string;
  /** 今回判定した試行。 */
  judged: number;
  /** 既に判定があって飛ばした試行(再開)。 */
  skipped: number;
  /** 判定しなかった試行。理由は {@link JudgeRunResult.warnings} に1行ずつ。 */
  excluded: number;
  /** `verdict: "error"` になったルールの総数(応答が読めなかったぶん)。 */
  ruleErrors: number;
  /** 判定しなかった理由。そのまま stderr へ出せる形。 */
  warnings: string[];
  /** run の全レコード(判定を書き戻したもの)。そのまま `report.ts` へ渡せる。 */
  records: TrialRecord[];
};

/**
 * run ディレクトリを判定して、**試行のJSONへ書き戻す**。
 *
 * **再開可能**にしてあるのは `run` と同じ理由 — 途中で止めても、判定済みの
 * 試行にもう一度払わない。判定済みの見分けは `record.judge` が読めるかどうかで、
 * 次の2つだけは判定し直す:
 *
 *   - 判定が**読めない**(古いスキーマ) … 読めない判定は判定ではない
 *   - 前回が `error` で終わっている … あれは通信やJSONの崩れで、
 *     モデルの成績ではない(直後に聞き直せば通ることが多い)
 *
 * 判定**しない**のも3つ。どれも数えて `warnings` に理由を残す(黙って分母から
 * 外すと、before/after の比較が静かに違う母数で並ぶ):
 *
 *   - `record.error` がある … ハーネス側の事故。記録が途中で切れている
 *   - 手順も教え返しも無い … 読むものが無い(`last_step: "none"` で足りる)
 *   - シナリオが `scenario.ts` に無い … 問題文が渡せず R6 が意味を失う
 */
export async function judgeRun(runDir: string, options: JudgeRunOptions): Promise<JudgeRunResult> {
  const { llm, model, onProgress, now } = options;
  const result: JudgeRunResult = {
    runDir,
    judged: 0,
    skipped: 0,
    excluded: 0,
    ruleErrors: 0,
    warnings: [],
    records: [],
  };

  const progress = (line: string): void => onProgress?.(line);

  for (const record of loadTrials(runDir)) {
    const meta = record.meta;
    const label = `${scenarioKey({ id: meta.scenario_id, locale: meta.locale })} t${meta.trial}`;
    const previous = readTrialJudge(record);

    if (previous !== undefined && previous.error === undefined) {
      result.skipped += 1;
      result.records.push(record);
      progress(`${label}  skip(判定済み)`);
      continue;
    }

    const excuse = skipReasonOf(record);
    if (excuse !== undefined) {
      result.excluded += 1;
      result.warnings.push(`${label}: ${excuse}`);
      result.records.push(record);
      progress(`${label}  skip(${excuse})`);
      continue;
    }

    const scenario = findScenario(meta.scenario_id, meta.locale);
    if (scenario === undefined) {
      const reason = "シナリオが scenario.ts にありません(問題文が渡せません)";
      result.excluded += 1;
      result.warnings.push(`${label}: ${reason}`);
      result.records.push(record);
      progress(`${label}  skip(${reason})`);
      continue;
    }

    const judge = await judgeTrial(record, {
      llm,
      scenario,
      ...(model === undefined ? {} : { model }),
      ...(now === undefined ? {} : { now }),
    });
    const judged: TrialRecord = { ...record, judge };
    saveTrial(runDir, judged);

    const counts = countVerdicts(judge);
    result.judged += 1;
    result.ruleErrors += counts.error;
    result.records.push(judged);
    progress(
      `${label}  ${previous === undefined ? "" : "再判定 "}pass=${counts.pass} fail=${counts.fail} n/a=${counts.not_applicable} err=${counts.error} mismatch=${judge.detector_mismatches.length}`,
    );
  }

  return result;
}

/** 判定しない理由(あれば)。**ハーネスの事故とモデルの成績を混ぜない。** */
function skipReasonOf(record: TrialRecord): string | undefined {
  if (record.error !== undefined) return `ハーネス側の事故: ${clip(record.error, 60)}`;
  if (record.turns.length === 0 && (record.teach_back?.messages.length ?? 0) === 0) {
    return "記録が空(手順も教え返しも無い)";
  }
  return undefined;
}
