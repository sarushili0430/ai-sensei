import type { CurriculumLocale } from "@ai-sensei/curriculum";

/**
 * Problem-text validity (the grounding guard).
 *
 * The `problem_text` the analyser transcribed goes straight to the senpai's board
 * LLM and becomes the starting point of what that lesson teaches. An answer mixed
 * in makes the senpai copy the answer instead of building the method - the board
 * degrades into an answer display.
 *
 * Post-revision promise 1 permits giving the answer (deck §0), but the board's
 * value is the reasoning, not the answer (§3-1's "formulas, working and figures go
 * on the board" means the method). Workbook pages sometimes print the chapter's
 * answers or red commentary alongside, and capturing the whole page lets those flow
 * in as problem text.
 *
 * ## Policy: perfection is not the goal. When unsure, let it through.
 *
 * Over-detection does more harm here. Rejecting a legitimate problem text leaves
 * `problem_text` empty and the senpai starts from "(no problem photo)" - putting us
 * back in the very state we wanted to avoid: teaching without looking at a problem
 * that is right there. Meanwhile a little answer text getting through only means
 * the senpai reads it as problem text, and the teach-back phase's insurance (§1-1)
 * still holds.
 *
 * So only signs that cannot appear in a problem text belong here:
 *
 *   - answer headings (`【解答】`, `[Solution]`, `解説:`). A bracket or colon is
 *     required so wording inside a question ("write on the answer sheet", "round
 *     your answer") is not caught
 *   - `∴` (therefore). It never appears in a question, only mid-solution
 *   - a fragment with no prose at all (just `x^2 - 3x + 2 = 0`). It does not say
 *     what is being asked
 *
 * Deliberately absent, and why:
 *   - "よって" / "したがって" ... they occur in questions too ("answer the value thus obtained")
 *   - a bare `Answer:` ... printed above a blank as the answer-box heading in
 *     workbooks. It appears on a page before the student solves anything, so it is
 *     no evidence of a mixed-in answer
 *   - a run of numbers (`(1) 2 (2) k=±√10`) ... indistinguishable from multiple-choice options
 *
 * Length caps belong to `problemTextMaxLength` in `@ai-sensei/contract` and to
 * `backend/api`, so they are not checked here (the same split as `latex-guard.ts`
 * not checking character counts).
 */

/**
 * Answer headings. Only forms that carry a bracket or a colon are matched.
 *
 * Matching a bare "解答" or "答" would catch "解答用紙", "解答欄", "答えを求めよ" and
 * "答えは小数第2位まで" inside the question itself. A heading is always delimited on
 * the page, so this form suffices.
 */
const solutionHeadings: readonly RegExp[] = [
  // 【解答】 [解説] (解) ［略解］ - a heading with bracket markers
  /[【[［(（〔]\s*(?:解答|解説|略解|解|答)\s*[】\]］)）〕]/u,
  // "解答:" / "解説:" right after a line start or a sentence end. Never mid-question.
  /(?:^|[\n。])\s*(?:解答|解説|略解)\s*[:：]/u,
  // [Solution] / (Answer) - bracketed. A bare `Answer:` is an answer-box heading and is excluded.
  /[[［(（]\s*(?:solution|answer|ans\.?)\s*[\]］)）]/iu,
  // "Solution:" at line start. `answer` is excluded (same reason as above).
  /(?:^|[\n.])\s*solutions?\s*[:：]/iu,
  // Therefore. Never in a question, only mid-solution.
  /∴|\\therefore\b/u,
];

/**
 * Whether there is any prose at all. Used as the sign that "what is being asked" is
 * written down.
 *
 *   - Japanese: kana must be present. A question always takes the form "〜を求めよ"
 *     or "次の〜", so a transcription with no kana is a formula or a heading fragment
 *   - English: an English word of 3+ letters. `Solve`, `Find` and `Prove` all
 *     qualify. Going to 2 letters would make variable names (`x`, `ab`) look like prose
 *
 * `sin`, `cos` and `log` are three letters and pass, and that is fine - this
 * function does not ask "is this a question" but only "is this obviously not one"
 * (when unsure, let it through).
 */
const kanaPattern = /[ぁ-んァ-ヶー]/u;
const proseWordPattern = /[A-Za-z]{3,}/u;

export const problemRejectionReasons = [
  /** An answer or worked solution is mixed into the problem text. */
  "solution_included",
  /** No question found (a formula-only fragment). */
  "not_a_problem",
] as const;
export type ProblemRejectionReason = (typeof problemRejectionReasons)[number];

export type ProblemVerdict =
  | { ok: true }
  | { ok: false; reason: ProblemRejectionReason; detail: string };

/**
 * Checks the transcribed problem text.
 *
 * It takes no locale. Answer headings do not share character sets between Japanese
 * and English ("解答" vs `Solution:`), so applying both at once cannot confuse them.
 * One fewer argument removes the "passed the wrong locale and it slipped through"
 * path entirely.
 */
export function checkProblemText(text: string): ProblemVerdict {
  const trimmed = text.trim();

  const heading = solutionHeadings.find((pattern) => pattern.test(trimmed));
  if (heading !== undefined) {
    return {
      ok: false,
      reason: "solution_included",
      detail: "問題文に解答・解説が混ざっています",
    };
  }

  if (!kanaPattern.test(trimmed) && !proseWordPattern.test(trimmed)) {
    return {
      ok: false,
      reason: "not_a_problem",
      detail: "設問が書かれていません(式だけの断片です)",
    };
  }

  return { ok: true };
}

/**
 * The instruction attached to the regeneration prompt. Written in the
 * conversation's language (same reason as `latex-guard.ts`).
 *
 * Its audience is the photo-analysis prompt (`prompts/photo_analysis.*.md`), not
 * the board LLM. What needs fixing is which part of the page to transcribe, so the
 * instruction names the range to capture.
 *
 * Nothing uses it yet. `backend/api`'s `resolveSessionProblem()` folds `problem` to
 * `null` without re-analysing - answers get mixed in because of how the page was
 * captured, so re-sending the same photo returns the same thing. It is kept here,
 * paired with its reason, for whenever a regeneration path is added. Whether to add
 * one should be decided from how often `solution_included` appears in the logs (if
 * it is frequent, what needs fixing is the analysis prompt, not re-analysis).
 */
export const problemRejectionGuidanceByLocale: Record<
  CurriculumLocale,
  Record<ProblemRejectionReason, string>
> = {
  ja: {
    solution_included:
      "problem_text には設問だけを書き写すこと。同じ紙面に章末の答え・赤字の解説・別冊解答が写っていても、そこは取らないこと。",
    not_a_problem:
      "problem_text に設問(「〜を求めよ」「〜を解け」など)まで含めて書き写すこと。式だけでは何を問われているか分かりません。設問が写っていなければ空文字にすること。",
  },
  en: {
    solution_included:
      "Copy only the question into problem_text. Even if the answer key, the worked solution, or the back-of-book answers are in the same photo, leave them out.",
    not_a_problem:
      'Include the actual instruction ("solve", "find", "prove") in problem_text, not just the expression. Without it there is no way to tell what is being asked. If no question is visible, use an empty string.',
  },
};

/** The default (no locale given) is the Japanese wording. */
export const problemRejectionGuidance: Record<ProblemRejectionReason, string> =
  problemRejectionGuidanceByLocale.ja;
