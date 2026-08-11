import { promptSources } from "./generated.ts";
import { type PromptLocale, type PromptTemplate, parsePrompt, renderPrompt } from "./render.ts";
export * from "./render.ts";

export const promptIds = [
  "photo_analysis",
  "senpai_conversation",
  "question_types_few_shot",
  "karte_generation",
  "math_speech_hints",
  "senpai_board",
  "study_plan",
] as const;
export type PromptId = (typeof promptIds)[number];

/** 既定のロケール。未対応の言語で来た場合もここに落ちる。 */
export const defaultPromptLocale: PromptLocale = "ja";

const templates = new Map<string, PromptTemplate>();
for (const source of Object.values(promptSources)) {
  const template = parsePrompt(source);
  templates.set(keyOf(template.meta.id, template.meta.locale), template);
}

function keyOf(id: string, locale: string): string {
  return `${id}:${locale}`;
}

/**
 * プロンプトを1本取り出す。
 *
 * 言語ごとに**別のファイル**を持つ(`prompts/<id>.<locale>.md`)。
 * 日本語のプロンプトの末尾に「英語で答えて」と足す作りにすると、
 * ペルソナも禁止事項も日本語のまま英語で薄く言い直されるだけになる。
 *
 * 未対応の言語は日本語に落とす(黙って落とす。ここで例外にすると、
 * 言語が1つ増えるたびに会話が始まらなくなる)。
 */
export function getPrompt(
  id: PromptId,
  locale: PromptLocale = defaultPromptLocale,
): PromptTemplate {
  const template =
    templates.get(keyOf(id, locale)) ?? templates.get(keyOf(id, defaultPromptLocale));
  if (!template) throw new Error(`プロンプトが見つかりません: ${id} (${locale})`);
  return template;
}

/** 全ロケールぶん。設計上の約束が書かれているかの検査に使う。 */
export function allPrompts(): PromptTemplate[] {
  return [...templates.values()];
}

export function promptsFor(locale: PromptLocale): PromptTemplate[] {
  return promptIds.map((id) => getPrompt(id, locale));
}

/**
 * 教え返しを聞く先輩のシステムプロンプト(ピボット計画 v1 §2 のコアループ2つ目)。
 *
 * few-shotと音声補正ヒントを常に同梱する。3つを別々に渡すと
 * 「片方だけ更新される」事故が起きるので、1本にまとめて返す。
 *
 * **`lesson_recap` は必須**(渡し忘れは `renderPrompt` が落とす)。先輩が
 * 「自分が何を板書したか」を知らないと、教え返しを聞いても
 * 「言えた / 詰まった」の判定ができない。板書がまだ無い場面(復習セッション・
 * 授業に入る前)は、その旨を**会話の言語で**書いた定型句を渡すこと。
 *
 * **板書の要約はここ(instructions)にだけ渡す。**カルテと小テストの材料は
 * transcript で、そこに教えた内容を混ぜると §2 の設計制約
 * 「出題元はユーザーが説明した内容。AIが教えた内容から作らない」が壊れる。
 * その線引きはプロンプト本文にも二重に書いてある。
 */
export function conversationSystemPrompt(
  variables: {
    photo_summary: string;
    visible_work: string;
    allowed_topics: string;
    question_seeds: string;
    lesson_recap: string;
    remaining_seconds: number;
  },
  locale: PromptLocale = defaultPromptLocale,
): string {
  return [
    renderPrompt(getPrompt("senpai_conversation", locale), variables),
    "---",
    getPrompt("question_types_few_shot", locale).body,
    "---",
    getPrompt("math_speech_hints", locale).body,
  ].join("\n\n");
}

/**
 * 板書つきで教える先輩のシステムプロンプト(ピボット計画 v1 §2 / §3-1)。
 *
 * 出力は `@ai-sensei/contract` の `boardLessonSchema` の形で、
 * agent がストリーミングJSONとして受け取る。
 *
 * **新規と復習で別のプロンプトを複製しない。**違うのは授業の根拠が
 * 「写真の問題」か「前回観測した1つの穴」かだけで、板書の契約、LaTeXの許可範囲、
 * 「数式は板書・声は接続」、教え返しへの受け渡しは同じ。300行を超える規約を
 * 別本にすると、片方だけ長い式の分割や禁止コマンドが抜けても型では検知できない。
 * `lesson_mode` を本文で明示し、入力の読み分けだけを同じ正本の中に置く。
 *
 * 復習の穴を `problem_text` に偽装する案も採らない。問題の写真が無いのに
 * 問題文として渡すと、「問題を推測しない」という新規授業の保険が形だけになる。
 * `review_context` は別の棚に置き、`problem_text` は写真についての事実のまま保つ。
 *
 * **音声補正ヒントを同梱する。** 先輩は喋るだけでなく、生徒の説明を聞いて
 * 「言えたか / 詰まったか」で教える地点を決める(=【申告させず、やらせる】)。
 * その判定材料はSTTを通った生徒の発話そのものなので、
 * 「さんぶんのに = 2/3」を取り違えると、**言えているのに詰まったと判定する**。
 *
 * few-shot(`question_types_few_shot`)は同梱しない。**先輩版に書き直したあとも同じ。**
 * あれは「教え返しを聞きながら差し込む一言」(相づち・足場・掘り方)の見本で、
 * こちらの出力は板書JSONなので置き場がない。`speech` の文体は
 * `senpai_board.<locale>.md` の見本セクションが直接そろえている。
 */
export function boardLessonSystemPrompt(
  variables: {
    lesson_mode: "new" | "review";
    problem_text: string;
    student_work: string;
    review_context: string;
    allowed_topics: string;
    remaining_seconds: number;
  },
  locale: PromptLocale = defaultPromptLocale,
): string {
  return [
    renderPrompt(getPrompt("senpai_board", locale), variables),
    "---",
    getPrompt("math_speech_hints", locale).body,
  ].join("\n\n");
}

/**
 * 学習計画を口で聞いて組む先輩のシステムプロンプト(ピボット計画 v1 §4-3)。
 *
 * 出力は `@ai-sensei/contract` の `planTurnSchema`(`{speech, plan}`)の形。
 * 計画は聞き取りの会話の**途中で**生まれるので、LLMの単位は「計画」ではなく「1ターン」。
 *
 * **音声補正ヒント(`math_speech_hints`)は同梱しない。** あれは数式の読み上げ
 * (「さんぶんのに」= 2/3)を直すためのもので、計画の聞き取りに出てくる数字は
 * **日付・ページ番号・問題集の名前**という別物。同梱しても効かないうえ、
 * 「エヌは数列ならn」のような文脈判断を持ち込むと、聞き取りの邪魔になる。
 * 計画側で要る聞き取りの注意は `prompts/study_plan.<locale>.md` に直接書いてある。
 *
 * `today` は**必ず渡す**。LLMは今日を知らないので、「9月10日」が何日後かも、
 * 今年か来年かも決められない(渡し忘れは `renderPrompt` が落とす)。
 */
export function studyPlanSystemPrompt(
  variables: {
    today: string;
    allowed_topics: string;
    known_facts: string;
    current_plan: string;
    remaining_seconds: number;
  },
  locale: PromptLocale = defaultPromptLocale,
): string {
  return renderPrompt(getPrompt("study_plan", locale), variables);
}

/** カルテ生成用のプロンプト。音声補正ヒントを同梱する。 */
export function karteSystemPrompt(
  variables: {
    photo_summary: string;
    allowed_topics: string;
    transcript: string;
    is_premium: string;
  },
  locale: PromptLocale = defaultPromptLocale,
): string {
  return [
    renderPrompt(getPrompt("karte_generation", locale), variables),
    "---",
    getPrompt("math_speech_hints", locale).body,
  ].join("\n\n");
}
