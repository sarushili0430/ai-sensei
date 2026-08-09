import { promptSources } from "./generated.ts";
import { type PromptLocale, type PromptTemplate, parsePrompt, renderPrompt } from "./render.ts";
export * from "./render.ts";

export const promptIds = [
  "photo_analysis",
  "kohai_conversation",
  "question_types_few_shot",
  "karte_generation",
  "math_speech_hints",
  "senpai_board",
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
 * 会話用のシステムプロンプト。
 * few-shotと音声補正ヒントを常に同梱する。3つを別々に渡すと
 * 「片方だけ更新される」事故が起きるので、1本にまとめて返す。
 */
export function conversationSystemPrompt(
  variables: {
    photo_summary: string;
    visible_work: string;
    allowed_topics: string;
    question_seeds: string;
    remaining_seconds: number;
  },
  locale: PromptLocale = defaultPromptLocale,
): string {
  return [
    renderPrompt(getPrompt("kohai_conversation", locale), variables),
    "---",
    getPrompt("question_types_few_shot", locale).body,
    "---",
    getPrompt("math_speech_hints", locale).body,
  ].join("\n\n");
}

/**
 * 板書つきで教える先輩のシステムプロンプト(ピボット計画 v1 §3-1)。
 *
 * 出力は `@ai-sensei/contract` の `boardLessonSchema` の形で、
 * agent がストリーミングJSONとして受け取る。
 *
 * **音声補正ヒントを同梱する。** 先輩は喋るだけでなく、生徒の説明を聞いて
 * 「言えたか / 詰まったか」で教える地点を決める(=【申告させず、やらせる】)。
 * その判定材料はSTTを通った生徒の発話そのものなので、
 * 「さんぶんのに = 2/3」を取り違えると、**言えているのに詰まったと判定する**。
 * few-shot(`question_types_few_shot`)は同梱しない — あれは
 * 「わかっていない後輩が質問する」文体で、教える側の文体ではない。
 */
export function boardLessonSystemPrompt(
  variables: {
    problem_text: string;
    student_work: string;
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
