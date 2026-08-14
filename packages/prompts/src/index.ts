import { promptSources } from "./generated.ts";
import {
  type PromptLocale,
  type PromptTemplate,
  parsePrompt,
  promptLocales,
  renderPrompt,
} from "./render.ts";
export * from "./render.ts";

export const promptIds = [
  "photo_analysis",
  "senpai_conversation",
  "question_types_few_shot",
  "karte_generation",
  "math_speech_hints",
  "english_speech_hints",
  "senpai_board",
  "senpai_board_english",
  "study_plan",
] as const;
export type PromptId = (typeof promptIds)[number];

/**
 * Which prompts exist in which languages. This is authoritative.
 *
 * Most prompts come in Japanese and English, but subject-bound ones do not.
 * `english_speech_hints` describes STT quirks of a Japanese speaker speaking
 * English, so it does not exist for curricula taught in English (this app has no
 * curriculum teaching English to English speakers).
 *
 * File-count checks use this as their basis. Counting
 * `promptIds.length * promptLocales.length` would falsely report "incomplete" the
 * moment a subject-specific prompt is added.
 */
export const promptCatalog: Record<PromptId, readonly PromptLocale[]> = {
  photo_analysis: promptLocales,
  senpai_conversation: promptLocales,
  question_types_few_shot: promptLocales,
  karte_generation: promptLocales,
  math_speech_hints: promptLocales,
  english_speech_hints: ["ja"],
  senpai_board: promptLocales,
  senpai_board_english: ["ja"],
  study_plan: promptLocales,
};

/** The default locale. Unsupported languages fall back here. */
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
 * Fetches one prompt.
 *
 * Each language has its own file (`prompts/<id>.<locale>.md`). Appending "answer in
 * English" to a Japanese prompt would only restate the persona and the bans thinly,
 * in Japanese.
 *
 * A missing combination throws rather than falling back to the default language.
 * Rounding unknown languages is {@link toPromptLocale}'s job, so the `locale`
 * arriving here is always one of `promptLocales`. If it is still not found, that id
 * has no version in that language, and silently returning the Japanese one would
 * have the senpai speak Japanese in an English session. When adding a language, add
 * the declaration to {@link promptCatalog}.
 */
export function getPrompt(
  id: PromptId,
  locale: PromptLocale = defaultPromptLocale,
): PromptTemplate {
  const template = templates.get(keyOf(id, locale));
  if (template) return template;
  throw new Error(
    `プロンプトがありません: ${id} (${locale})。このidは ${promptCatalog[id].join(" / ")} にだけあります`,
  );
}

/** All locales. Used to check that the design promises are written down. */
export function allPrompts(): PromptTemplate[] {
  return [...templates.values()];
}

/** Every prompt available in that locale. */
export function promptsFor(locale: PromptLocale): PromptTemplate[] {
  return promptIds
    .filter((id) => promptCatalog[id].includes(locale))
    .map((id) => getPrompt(id, locale));
}

/**
 * The lesson's subject.
 *
 * Keep these values identical to `CurriculumSubject` in `@ai-sensei/curriculum`.
 * This package is a dependency-free layer (the same reason `formatAllowedTopics`
 * takes topics structurally), so it cannot reference them and writes them twice.
 */
export const promptSubjects = ["math", "english"] as const;
export type PromptSubject = (typeof promptSubjects)[number];

/**
 * Per-subject speech-correction hints.
 *
 * Always switched by subject. Applying the maths version's "さんぶんのに = 2/3" and
 * "にじょう = ^2" to an English lesson would re-read the student's speech as
 * formulas. Conversely the English version's "a dropped article is not evidence
 * they failed to say it" does nothing for maths.
 */
function speechHintsId(subject: PromptSubject): PromptId {
  return subject === "math" ? "math_speech_hints" : "english_speech_hints";
}

/** The per-subject board prompt. Neither the usable elements nor the rules overlap. */
function boardPromptId(subject: PromptSubject): PromptId {
  return subject === "math" ? "senpai_board" : "senpai_board_english";
}

/** The lesson context used when assembling a system prompt. */
export type PromptContext = {
  locale?: PromptLocale;
  /** The lesson's subject. Derivable with `subjectOfTopicId(topic_id)` (ADR 0007). */
  subject: PromptSubject;
};

/**
 * The system prompt for the senpai listening to teach-back (the second half of
 * pivot plan v1 §2's core loop).
 *
 * The few-shot examples and the speech-correction hints are always bundled in.
 * Passing the three separately invites "only one got updated", so one string is
 * returned.
 *
 * `lesson_recap` is required (`renderPrompt` fails if it is missing). Without
 * knowing what it wrote on the board, the senpai cannot judge "said it / got stuck"
 * while listening to the teach-back. Where there is no board yet (a review session,
 * before the lesson starts), pass a fixed line saying so in the conversation's
 * language.
 *
 * The board summary is passed here (instructions) only. The karte and the quiz are
 * built from the transcript, and mixing what was taught into it breaks §2's design
 * constraint that "questions come from what the user explained, never from what the
 * AI taught". That line is written into the prompt body too.
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
  { locale = defaultPromptLocale, subject }: PromptContext,
): string {
  return [
    renderPrompt(getPrompt("senpai_conversation", locale), variables),
    "---",
    getPrompt("question_types_few_shot", locale).body,
    "---",
    getPrompt(speechHintsId(subject), locale).body,
  ].join("\n\n");
}

/**
 * The system prompt for the senpai teaching with a board (pivot plan v1 §2 / §3-1).
 *
 * The output has the shape of `boardLessonSchema` in `@ai-sensei/contract`, which
 * the agent receives as streaming JSON.
 *
 * New lessons and reviews do not get duplicate prompts. The only difference is
 * whether the lesson is grounded in the photographed problem or in one hole
 * observed last time; the board contract, the LaTeX allow-list, "formulas on the
 * board, voice for connection" and the handover to teach-back are identical.
 * Splitting 300+ lines of rules into two books means a missing long-formula split
 * or banned command on one side cannot be detected by types. `lesson_mode` is
 * stated in the body, and only the reading of the input differs inside the same
 * source of truth.
 *
 * Disguising a review hole as `problem_text` is also rejected. Passing it as
 * problem text when there is no problem photo would make the new-lesson insurance
 * "do not guess the problem" purely nominal. `review_context` sits on its own
 * shelf, and `problem_text` stays a fact about the photo.
 *
 * The speech-correction hints are bundled in. The senpai not only speaks but
 * listens to the student's explanation to decide where to teach from ("make them do
 * it, do not make them report it"). That judgement rests on the student's speech as
 * it came through STT, so misreading "さんぶんのに = 2/3" judges them stuck when
 * they said it correctly.
 *
 * The few-shot (`question_types_few_shot`) is not bundled, and that stays true even
 * after it is rewritten for the senpai. Those are examples of "lines to slip in
 * while listening to teach-back" (acknowledgements, scaffolds, ways to dig), and
 * this output is board JSON with nowhere to put them. `speech`'s tone is aligned
 * directly by the examples section in `senpai_board.<locale>.md`.
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
  { locale = defaultPromptLocale, subject }: PromptContext,
): string {
  return [
    // A separate book per subject. In the maths version, 30-40% of its 300+ lines are
    // formula rules (usable LaTeX commands, how to split long formulas), all of it
    // unnecessary for English. Separate sources read better than one file full of
    // branches (the same call as ADR 0005 decision 3).
    renderPrompt(getPrompt(boardPromptId(subject), locale), variables),
    "---",
    getPrompt(speechHintsId(subject), locale).body,
  ].join("\n\n");
}

/**
 * The system prompt for the senpai building a study plan by ear (pivot plan v1 §4-3).
 *
 * The output has the shape of `planTurnSchema` (`{speech, plan}`) in
 * `@ai-sensei/contract`. A plan is born *during* the interview, so the LLM's unit is
 * one turn, not one plan.
 *
 * The speech-correction hints are not bundled. Those fix formula readings
 * ("さんぶんのに" = 2/3) and dropped English sounds, whereas the numbers in a plan
 * interview are dates, page numbers and workbook names - different things.
 * Bundling them would not help and would import context judgements like "N means n
 * in a sequence", getting in the interview's way. The listening notes the plan side
 * needs are written directly in `prompts/study_plan.<locale>.md`.
 *
 * This is also why it takes no subject. One plan spans subjects (a middle-schooler's
 * term test lines up maths and English), so fixing a single subject here is meaningless.
 *
 * `today` must always be passed. The LLM does not know today, so it can decide
 * neither how many days away "10 September" is nor whether it is this year or next
 * (`renderPrompt` fails if it is missing).
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

/** The prompt for karte generation. Bundles the speech-correction hints for the subject. */
export function karteSystemPrompt(
  variables: {
    photo_summary: string;
    allowed_topics: string;
    transcript: string;
    is_premium: string;
  },
  { locale = defaultPromptLocale, subject }: PromptContext,
): string {
  return [
    renderPrompt(getPrompt("karte_generation", locale), variables),
    "---",
    getPrompt(speechHintsId(subject), locale).body,
  ].join("\n\n");
}
