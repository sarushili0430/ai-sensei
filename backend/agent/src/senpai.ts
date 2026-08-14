import type { BoardStep } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { boardLessonSystemPrompt, conversationSystemPrompt } from "@ai-sensei/prompts";
import { type SessionContext, subjectOf } from "./context.ts";

/**
 * What connects the board lesson to phase 2, teaching back — the parts that can
 * only live on the agent side.
 *
 * Personality and promises are not here. The canonical text is
 * `prompts/senpai_conversation.{ja,en}.md`; this file holds only three things:
 *
 *   1. Fixed lines (handing over to the teach-back, and recovery). They go
 *      straight to TTS without passing through the conversational LLM, so they
 *      cannot live in a prompt.
 *   2. The board summary (the value put into `lesson_recap`). The board is a
 *      delivery-layer fact (`BoardStep`) and is invisible from the prompt side.
 *   3. Values copied from the session context into each prompt, so a photo and a
 *      review gap are selectable via `lesson_mode` rather than disguised as the
 *      same field.
 *
 * ## Board content goes into instructions only, never into the transcript
 *
 * Without knowing what senpai taught, a teach-back cannot be judged as "said it"
 * or "got stuck". But the design constraint is that questions come from what the
 * user explained, never from what the AI taught, so the karte and the quiz draw
 * on the transcript alone.
 *
 * So the board summary is passed only into instructions (this layer), and
 * in-lesson utterances are kept out of the transcript with `addToChatCtx: false`
 * (`agent.ts`). The split is "senpai knows it, but it is not karte material". The
 * same line is drawn again in the body of `senpai_conversation.<locale>.md`.
 */

/** Hands over to the teach-back once the lesson ends; the core loop's step two. */
const TEACH_BACK_PROMPT: Record<CurriculumLocale, string> = {
  ja: "じゃあ今の、自分の言葉で説明してみて。",
  en: "Alright — now explain that back to me in your own words.",
};

/**
 * Recovery when not one board line could be produced.
 *
 * It never falls silently into conversation. "Now explain that back" with an
 * empty board asks the student to explain something they were never taught. It
 * acknowledges what happened and restarts by asking where they got stuck.
 */
const LESSON_FAILED_PROMPT: Record<CurriculumLocale, string> = {
  ja: "ごめん、板書がうまく出せなかった。口でやろっか。この問題、どこまでできた?",
  en: "Sorry — the board didn't come up. Let's just talk it through. How far did you get?",
};

/**
 * The opening line of a review session: no board, asking again from the previous
 * gap.
 *
 * Normal reviews start a board from `review_hole`. This is the compatibility
 * fallback for the deployment window where a newer agent shipped first and an
 * older API sent no such field.
 *
 * It never asks "do you remember?". That is exactly the self-reporting question
 * `senpai_conversation.*.md` forbids, answerable with "yes". Have them say it and
 * judge from that.
 */
const REVIEW_OPENING: Record<CurriculumLocale, string> = {
  ja: "この前つまずいたとこ、もう一回説明してみて。",
  en: "Let's take another run at the bit you got stuck on — explain it to me.",
};

/** A review has no "this problem", so recovery also restarts from the gap. */
const REVIEW_LESSON_FAILED_PROMPT: Record<CurriculumLocale, string> = {
  ja: "ごめん、板書がうまく出せなかった。口でやろっか。前に止まったところ、何が引っかかる?",
  en: "Sorry — the board didn't come up. Let's talk it through. What catches you at that spot?",
};

/**
 * The boilerplate put into `lesson_recap` when the board is still empty.
 *
 * Written in the conversation's language: a Japanese "(none)" inside an English
 * prompt makes the model start replying in Japanese there (the same reason as
 * `phrases` in `render.ts`). It is not an empty string, because a section left
 * with only a heading can read to senpai as "there is a board but I cannot read
 * it". State the absence.
 */
const NO_LESSON_RECAP: Record<CurriculumLocale, string> = {
  ja: "(まだ板書には何も出していません)",
  en: "(nothing on the board yet)",
};

/**
 * Whether the last step already handed the turn to the student.
 *
 * Appending {@link teachBackPrompt} when it did makes senpai say the same thing
 * twice. The board prompt (`senpai_board.*.md`) instructs it to always hand over
 * after teaching, so this happens on every lesson that simply went well.
 *
 * It matches on "was the turn handed over", not on exact wording. A lesson ending
 * on a narrowing question ("say the first move") is also waiting for an answer
 * and counts the same.
 */
const HANDOFF_PATTERNS: Record<CurriculumLocale, RegExp[]> = {
  ja: [/説明してみて/, /言ってみて/, /やってみて/, /話してみて/, /書いてみて/],
  en: [/explain\b/i, /your own words/i, /tell me\b/i, /give it a (?:go|shot|try)/i, /try it\b/i],
};

/**
 * A question mark. Treating only "try saying..." forms as handing over the turn
 * was the real break.
 *
 * A lesson whose problem photo could not be read starts, as the board prompt
 * instructs, with "could you read the problem out for me?". That matches none of
 * the patterns above, so `teachBackFallback` unconditionally appended "now
 * explain that back in your own words" (exactly the 2026-08-12 report). To the
 * student, being asked to read something aloud is immediately followed by being
 * asked to explain something they have not been taught.
 *
 * If senpai ends on a question, whatever its shape, the turn is already with the
 * student.
 *
 * The full-width question mark is written as a code point. It was once written
 * literally and got flattened to half-width (it looked like two characters but
 * was two ASCII `?`), so full-width never matched. Japanese output is almost
 * entirely full-width, so that miss affects every Japanese lesson and silently
 * reverts the turn-taking fix. Written literally it would break the same way
 * again, so it is written so the difference is visible.
 */
const QUESTION_MARK = /[?？]\s*$/;

export function teachBackPrompt(locale: CurriculumLocale): string {
  return TEACH_BACK_PROMPT[locale];
}

export function lessonFailedPrompt(
  locale: CurriculumLocale,
  kind: SessionContext["kind"] = "new",
): string {
  return kind === "review" ? REVIEW_LESSON_FAILED_PROMPT[locale] : LESSON_FAILED_PROMPT[locale];
}

export function reviewOpening(locale: CurriculumLocale): string {
  return REVIEW_OPENING[locale];
}

export function handsTurnToStudent(speech: string, locale: CurriculumLocale): boolean {
  const normalized = speech.trim();
  if (normalized.length === 0) return false;
  if (QUESTION_MARK.test(normalized)) return true;
  return HANDOFF_PATTERNS[locale].some((pattern) => pattern.test(normalized));
}

/**
 * Whether the session opens with a board lesson.
 *
 * A `review` is created only after the quiz already went "not yet" -> "ask
 * senpai". Asking for an explanation again here would step back from "when stuck,
 * enter lesson mode" and make the student demonstrate the same block twice to get
 * taught. So both normal kinds start from the board. The exception is the rolling
 * deployment window where a newer agent shipped first and the older API sends no
 * `review_hole`: that review alone builds no board without evidence and degrades
 * to the previous ask-again conversation.
 */
export function startsWithBoardLesson(
  context: Pick<SessionContext, "kind" | "review_hole">,
): boolean {
  return context.kind === "new" || context.review_hole != null;
}

/**
 * The JSON that pastes a review gap into the board prompt.
 *
 * The gap is not stuffed into `problem_text`. Mixing the fact of a problem photo
 * with a previous observation would disable the new-lesson safeguard that says
 * "with no problem photo, do not guess". JSON keeps newlines and quotes in `desc`
 * / `evidence` inside the data boundary so they cannot become headings. New
 * lessons pass the string `null`, adding no locale-specific dummy wording.
 */
export function renderReviewBoardContext(context: SessionContext): string {
  return context.review_hole == null ? "null" : JSON.stringify(context.review_hole, null, 2);
}

export type SenpaiBoardLessonInput = {
  context: SessionContext;
  remainingSeconds: number;
};

/**
 * Maps photo-started and gap-started lessons onto explicit modes of the same
 * board prompt.
 *
 * Why a separate review prompt was not copied is documented in
 * `packages/prompts/src/index.ts`. Both inputs are passed and the body selects
 * one by mode. Reviews still pass `problem_text` as the contract's placeholder,
 * so the absence of a photo is not overwritten by the gap's description.
 */
export function senpaiBoardLessonPrompt(input: SenpaiBoardLessonInput): string {
  const { context } = input;
  return boardLessonSystemPrompt(
    {
      lesson_mode: context.kind,
      problem_text: context.problem_text,
      student_work: context.visible_work,
      review_context: renderReviewBoardContext(context),
      allowed_topics: context.allowed_topics,
      remaining_seconds: input.remainingSeconds,
    },
    { locale: context.locale, subject: subjectOf(context) },
  );
}

/**
 * Whether anything was written on the board. Voice-only steps do not count as
 * teaching.
 *
 * Steps with `board: null` are the slot for narrowing questions and
 * acknowledgements. A lesson that produced only those leaves the student a blank
 * board with a heading, and nothing taught survives anywhere.
 */
export function wroteOnBoard(steps: readonly BoardStep[]): boolean {
  return steps.some((step) => step.board !== null);
}

/**
 * The code-side safety net for when the board LLM forgets to hand over the turn
 * on its last line.
 *
 * Left to the prompt alone, one wobbly generation ends with "taught, and done".
 * Appending the fixed line every time, though, asks the same question twice. So
 * it inspects the last step actually delivered and hands back only when that is
 * missing.
 *
 * It appends nothing when no board line was written: there is no "that" in "now
 * explain that", so it would ask the student to explain what they were never
 * taught. What actually happened was this pair — and since the conversation
 * prompt is pinned to "what we are doing now: teaching back", it loops:
 *
 *   senpai: "could you read the problem out for me?"  <- first line when the
 *                                                        photo yielded no text
 *   senpai: "now explain that back in your own words." <- appended unconditionally
 *
 * Recovery is the caller's job (`agent.ts` emits `lessonFailedPrompt`). This only
 * decides not to append.
 */
export function teachBackFallback(
  context: Pick<SessionContext, "locale">,
  steps: readonly BoardStep[],
): string | null {
  const last = steps.at(-1);
  if (last === undefined || handsTurnToStudent(last.speech, context.locale)) return null;
  if (!wroteOnBoard(steps)) return null;
  return teachBackPrompt(context.locale);
}

/**
 * Character cap on the board summary.
 *
 * One board holds up to 40 steps (`boardStepsMaxCount`) with `speech` up to 120
 * characters and `tex` up to 200, so a full one runs to tens of kilobytes.
 * Instructions are sent in full every turn, so including it whole would pay for
 * the board in input tokens on every exchange.
 *
 * On overflow it fills from the start and stops when it no longer fits, dropping
 * the tail. A lesson accumulates from the top, so a cut still reads as "this much
 * was taught". Dropping the head instead would leave a disjointed board with the
 * premises missing.
 */
export const lessonRecapMaxLength = 2000;

/** Writes one board element as a line, purely to remind senpai what it wrote. */
function describeBoard(board: BoardStep["board"], locale: CurriculumLocale): string | null {
  if (board === null) return null;
  const label = locale === "en" ? "board" : "板書";
  switch (board.kind) {
    case "latex":
      return `${label}: ${board.tex}`;
    case "text":
      return `${label}: ${board.body}`;
    case "plot":
      return `${label}: y = ${board.fn} (${board.domain.min} .. ${board.domain.max})`;
    case "triangle":
      return `${label}: ${locale === "en" ? "triangle" : "三角形"}${
        board.labels === undefined ? "" : ` ${board.labels.join("")}`
      }`;
    case "circle":
      return `${label}: ${locale === "en" ? "circle" : "円"} r = ${board.r}`;
    case "figure":
      // Name the labelled points. Folding this to just "figure" leaves senpai
      // unable to recall the points it placed, so the next explanation redraws the
      // same figure (the cause of D-12, "figures do not grow"). `alt` is filled in
      // by the agent, so before validation it falls back to the names.
      return `${label}: ${board.alt ?? (locale === "en" ? "figure" : "図")}${(() => {
        const names = board.items
          .map((item) => item.pt)
          .filter((name): name is string => typeof name === "string");
        return names.length === 0 ? "" : ` [${names.join(" ")}]`;
      })()}`;
    // The English board: keep the example sentence and the focus it showed.
    // "An example was given" alone leaves nothing to ask back about.
    case "sentence":
      return [
        `${label}: ${board.text}`,
        board.gloss === undefined ? null : `(${board.gloss})`,
        board.focus === undefined ? null : `[${board.focus}]`,
      ]
        .filter((part) => part !== null)
        .join(" ");
    case "compare":
      return `${label}: ${board.title ?? board.columns.join(" / ")} — ${board.rows
        .map((row) => row.join(" / "))
        .join(" | ")}`;
    default:
      return null;
  }
}

/**
 * Folds the delivered board into something senpai can read back. With no lines it
 * returns the boilerplate that states the absence, not an empty string (see
 * `NO_LESSON_RECAP` above).
 */
export function renderLessonRecap(
  steps: readonly BoardStep[],
  locale: CurriculumLocale,
  maxLength: number = lessonRecapMaxLength,
): string {
  const lines: string[] = [];
  let length = 0;

  // Quotation marks match the body's language: Japanese brackets inside an
  // English prompt make the model start replying in Japanese there (the same
  // reason as `phrases` in `render.ts`).
  const [open, close] = locale === "en" ? ['"', '"'] : ["「", "」"];

  for (const step of steps) {
    const board = describeBoard(step.board, locale);
    const line = `${step.index + 1}. ${open}${step.speech}${close}${
      board === null ? "" : ` / ${board}`
    }`;
    if (length + line.length > maxLength) break;
    lines.push(line);
    length += line.length + 1;
  }

  return lines.length === 0 ? NO_LESSON_RECAP[locale] : lines.join("\n");
}

export type SenpaiConversationInput = {
  context: SessionContext;
  /** Time left in the conversation, used to decide when to wrap up. */
  remainingSeconds: number;
  /** Steps actually put on the wire; empty only before the lesson. */
  lesson?: readonly BoardStep[];
};

/**
 * The system prompt for senpai listening to a teach-back.
 *
 * A layer that only copies `SessionContext` and the board's steps into the
 * prompt's variables. Personality, promises and how to ask live in
 * `prompts/senpai_conversation.<locale>.md`; wanting to add wording here means it
 * belongs there.
 */
export function senpaiConversationPrompt(input: SenpaiConversationInput): string {
  const locale = input.context.locale;
  return conversationSystemPrompt(
    {
      photo_summary: input.context.photo_summary,
      visible_work: input.context.visible_work,
      allowed_topics: input.context.allowed_topics,
      question_seeds: input.context.question_seeds,
      lesson_recap: renderLessonRecap(input.lesson ?? [], locale),
      remaining_seconds: input.remainingSeconds,
    },
    { locale, subject: subjectOf(input.context) },
  );
}
