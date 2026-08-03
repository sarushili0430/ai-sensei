import { promptSources } from "./generated.ts";
import { parsePrompt, renderPrompt, type PromptTemplate } from "./render.ts";

export * from "./render.ts";

export const promptIds = [
  "photo_analysis",
  "kohai_conversation",
  "question_types_few_shot",
  "karte_generation",
  "math_speech_hints",
] as const;
export type PromptId = (typeof promptIds)[number];

const templates = new Map<string, PromptTemplate>();
for (const source of Object.values(promptSources)) {
  const template = parsePrompt(source);
  templates.set(template.meta.id, template);
}

export function getPrompt(id: PromptId): PromptTemplate {
  const template = templates.get(id);
  if (!template) throw new Error(`プロンプトが見つかりません: ${id}`);
  return template;
}

export function allPrompts(): PromptTemplate[] {
  return [...templates.values()];
}

/**
 * 会話用のシステムプロンプト。
 * few-shotと音声補正ヒントを常に同梱する。3つを別々に渡すと
 * 「片方だけ更新される」事故が起きるので、1本にまとめて返す。
 */
export function conversationSystemPrompt(variables: {
  photo_summary: string;
  visible_work: string;
  allowed_topics: string;
  question_seeds: string;
  remaining_seconds: number;
}): string {
  return [
    renderPrompt(getPrompt("kohai_conversation"), variables),
    "---",
    getPrompt("question_types_few_shot").body,
    "---",
    getPrompt("math_speech_hints").body,
  ].join("\n\n");
}

/** カルテ生成用のプロンプト。音声補正ヒントを同梱する。 */
export function karteSystemPrompt(variables: {
  photo_summary: string;
  allowed_topics: string;
  transcript: string;
  is_premium: string;
}): string {
  return [
    renderPrompt(getPrompt("karte_generation"), variables),
    "---",
    getPrompt("math_speech_hints").body,
  ].join("\n\n");
}
