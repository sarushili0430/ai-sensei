import type { Subject } from "@ai-sensei/curriculum";
import { promptSources } from "./generated.ts";
import { type PromptTemplate, parsePrompt, renderPrompt } from "./render.ts";

export * from "./render.ts";

export const promptIds = [
  "photo_analysis",
  "kohai_conversation",
  "karte_generation",
  "question_types_math_few_shot",
  "math_speech_hints",
  "question_types_english_grammar_few_shot",
  "english_grammar_speech_hints",
] as const;
export type PromptId = (typeof promptIds)[number];

/**
 * 科目ごとに差し替えるプロンプト。
 *
 * 質問の文体(few-shot)と音声の補正ヒントは、科目が変わると中身が変わる。
 * 数学のfew-shotのまま英文法を話させると「判別式」の例文に引きずられ、
 * 数式の補正ヒントを英文法に添えると、英語の説明に数式の読み替えが混ざる。
 */
const subjectPrompts: Record<Subject, { fewShot: PromptId; speechHints: PromptId }> = {
  数学: {
    fewShot: "question_types_math_few_shot",
    speechHints: "math_speech_hints",
  },
  英文法: {
    fewShot: "question_types_english_grammar_few_shot",
    speechHints: "english_grammar_speech_hints",
  },
};

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

/** その科目で使うfew-shotと音声補正ヒントのid。 */
export function promptIdsForSubject(subject: Subject): {
  fewShot: PromptId;
  speechHints: PromptId;
} {
  return subjectPrompts[subject];
}

/**
 * 会話用のシステムプロンプト。
 * few-shotと音声補正ヒントを常に同梱する。3つを別々に渡すと
 * 「片方だけ更新される」事故が起きるので、1本にまとめて返す。
 * どのfew-shot・どのヒントを添えるかは**科目で決まる**。
 */
export function conversationSystemPrompt(variables: {
  subject: Subject;
  photo_summary: string;
  visible_work: string;
  allowed_topics: string;
  question_seeds: string;
  remaining_seconds: number;
}): string {
  const { fewShot, speechHints } = subjectPrompts[variables.subject];
  return [
    renderPrompt(getPrompt("kohai_conversation"), variables),
    "---",
    getPrompt(fewShot).body,
    "---",
    getPrompt(speechHints).body,
  ].join("\n\n");
}

/** カルテ生成用のプロンプト。科目に応じた音声補正ヒントを同梱する。 */
export function karteSystemPrompt(variables: {
  subject: Subject;
  photo_summary: string;
  allowed_topics: string;
  transcript: string;
  is_premium: string;
}): string {
  return [
    renderPrompt(getPrompt("karte_generation"), variables),
    "---",
    getPrompt(subjectPrompts[variables.subject].speechHints).body,
  ].join("\n\n");
}
