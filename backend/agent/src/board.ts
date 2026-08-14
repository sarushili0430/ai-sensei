import {
  type BoardChannelMessage,
  type BoardStep,
  boardChannelMessageSchema,
  boardChannelTopic,
  boardFigureAltMaxLength,
  boardFigureSvgMaxLength,
  boardLessonStepsMaxCount,
  boardProtocolVersion,
  boardStepSchema,
  boardStepsMaxCount,
} from "@ai-sensei/contract";
import {
  type CurriculumLocale,
  type CurriculumSubject,
  subjectOfTopicId,
} from "@ai-sensei/curriculum";
import { drawFigure } from "@ai-sensei/figure";
import {
  type AllowedTopics,
  type LatexRejectionReason,
  buildAllowedTopics,
  checkBoardLatex,
  isAllowedTopic,
  latexRejectionGuidanceByLocale,
} from "@ai-sensei/guardrail";
import katex from "katex";
import { BoardLessonStreamParser, BoardStreamError } from "./board-stream.ts";
import type { JobLogger } from "./log.ts";

/**
 * The board's delivery layer. It streams the LLM's output to LiveKit Text
 * Streams (topic `board`) one step at a time, as each step closes.
 *
 * This file is plumbing only. What to write on the board (senpai's voice, how to
 * teach, how to build the working) belongs to the prompt and is unknown here.
 * Conversely the destination (`session_id`), the board's identity (`board_id`),
 * ordering (`seq` / `index`) and how it closes (`reason`) are entirely ours and
 * never leak into the LLM's output (see the split in `contract/src/board.ts`).
 *
 * ## Lifetime: one board = one problem, not one LLM call
 *
 * Teaching does not finish in one turn:
 *
 *   turn 1: narrow it down ("say the first move") -> stop to hear the answer
 *   the student answers
 *   turn 2: teach from where they got stuck
 *   turn 3: "now explain that back in your own words"
 *
 * Reopening the board per LLM call would erase it on every conversational turn,
 * because the contract only clears the board on `board_open`. The rule that
 * earlier lines survive and clear only when moving to another problem would
 * break every turn, losing the board's whole value.
 *
 * So {@link BoardChannel.startBoard} starts one board, each explanation appends
 * to the same `board_id` via {@link BoardDelivery.append}, and
 * {@link BoardDelivery.close} closes it when the problem ends. The running
 * `index` is assigned here; the LLM does not know which call it is on, and
 * telling it would put hallucinated numbers on the wire.
 *
 * ## Design decision: validating while sending means earlier steps cannot be
 * ## retracted
 *
 * On an eight-step board, steps 0-4 are sent and step 5's `tex` is rejected by
 * `checkBoardLatex`. The send cannot be undone (the board accumulates, and only
 * `board_open` clears it).
 *
 * We take (b): have only the failed step redone and keep going. Past the retry
 * limit we abandon that explanation and leave the board open, so what is there
 * survives and the next explanation continues on the same board.
 *
 * Reasons:
 *
 * 1. (a) buffer everything, then send — rejected. Streaming was chosen so the
 *    student can interrupt and is not kept waiting; full buffering is the option
 *    that lost then, and nothing has changed. It also does not solve this
 *    problem: it means discarding and rebuilding a whole board, which waits
 *    longer than redoing one step.
 *
 * 2. (b)'s wait is the same order as one step's audio, and whether it hides
 *    depends on where the cover comes from.
 *
 *    This originally said "one step is 120 characters of `speech`, roughly 20-25
 *    seconds of TTS, so the wait hides behind it". That was wrong: 120 is the
 *    contract's ceiling, not a typical value. Keeping speech to questions and
 *    connective tissue pushes away from the ceiling, not towards it, and in
 *    practice it does. Measured over the seven steps in
 *    `packages/contract/fixtures/board-lesson.json`:
 *
 *      median 14 characters ~ 2.5s, longest 29 ~ 5.3s (Japanese TTS, 330 cpm)
 *      the English fixture lands in the same band, 2.8-4.1s
 *
 *    So one step's audio is 2-5 seconds, the same order as a regeneration round
 *    trip. The wrong version is recorded here so the "20 seconds of slack per
 *    step" premise does not survive into the next person's changes.
 *
 *    The real slack is the lead that builds up because generating is faster than
 *    speaking: producing one step's JSON (tens of tokens) takes less time than
 *    reading it aloud, and the difference accumulates. A regeneration at step 5
 *    is drawn against the lead built over steps 0-4, so regeneration is most
 *    visible early and least visible late. A failure on the very first step has
 *    no lead at all and the wait becomes silence — the same hole the pre-rendered
 *    opening audio was introduced to fill.
 *
 *    Where the lead accumulates depends on how the caller writes
 *    {@link AppendBoardOptions.onStep}. Handing to TTS and returning at once puts
 *    the lead into delivery itself (the board runs ahead of the voice). Waiting
 *    until speech finishes keeps step-level synchronization but leaves the lead
 *    only on the generation side, so a regeneration round trip surfaces as
 *    silence. If you take the latter, treat the wait as unhidden — which is why
 *    {@link defaultMaxRepairAttempts} is 1.
 *
 * 3. Steps already sent are not invalidated by the next one failing. The board
 *    accumulates one line per step, and step 4 is not a draft of step 5. The
 *    rejection is a rendering reason ("`flutter_math_fork` cannot draw this"),
 *    not a statement that step 4 was wrong. There is nothing to retract.
 *
 * 4. (c) rebuild the whole board — not worth it. Its drawback is not that
 *    "`board_close(error)` resets the screen": by contract only `board_open`
 *    clears anything, and `board_close` erases nothing. The reset comes from the
 *    `board_open` sent afterwards. So (c)'s real cost is that a board the student
 *    is reading goes blank at a moment they cannot account for, breaking "earlier
 *    lines are never erased" for an internal reason they cannot observe.
 *
 * 5. Hence a dead end still does not close the board. On hitting the retry
 *    limit, that `append()` stops and returns `reason: "error"`, sending neither
 *    `board_open` nor `board_close`. The board stays open with what it has, and
 *    the next explanation continues on it. Senpai carries on in voice, and the
 *    screen only changes when the next problem starts. "Stop on breakage, but
 *    erase nothing and leave room for what comes next" is how this layer fails.
 *
 *    The one case that closes the board is the step limit
 *    ({@link boardStepsMaxCount}). Nothing more can be appended, so leaving it
 *    open would have the caller calling the LLM into a black hole.
 *
 * Regeneration itself (calling the LLM again) is factored out as
 * {@link StepRepair}. The rejection carries the matching
 * `latexRejectionGuidanceByLocale` instruction, so the caller only has to add
 * that text to the prompt and ask again. Keeping it out of this file is what
 * lets this layer be tested without real keys.
 */

/** Where one envelope goes. A thin seam so LiveKit can be swapped out. */
export type BoardSink = {
  send(message: BoardChannelMessage): Promise<void>;
};

/** Anything with `sendText` (`room.localParticipant`); structural, so this file does not depend on LiveKit's types. */
export type TextStreamPublisher = {
  sendText(text: string, options?: { topic?: string }): Promise<unknown>;
};

/**
 * Sink that writes to LiveKit Text Streams.
 *
 * One envelope is one stream. `sendText` opens, writes and closes in a single
 * call, so the receiver's `readAll()` means exactly "one envelope is complete".
 * Raw `publishData` is not used: its LOSSY default silently drops board lines
 * when forgotten.
 */
export function createTextStreamBoardSink(publisher: TextStreamPublisher): BoardSink {
  return {
    async send(message) {
      await publisher.sendText(JSON.stringify(message), { topic: boardChannelTopic });
    },
  };
}

/** Why a step failed validation, including the regeneration instruction. */
export type BoardStepRejection = {
  /** Where the failed step would have gone (the `index` being sent). */
  index: number;
  /**
   * `latex` is an undrawable command (tier 2), `syntax` is broken syntax
   * (tier 3), `schema` is a contract violation (length or shape), and `figure`
   * is a construction that could not be solved.
   */
  kind: "latex" | "syntax" | "schema" | "figure";
  reason: LatexRejectionReason | "syntax" | "schema" | "figure" | "figure_too_large";
  /** What tripped it, for logging. */
  detail: string;
  /** The regeneration instruction, in the conversation's language; append as is. */
  guidance: string;
  /** The raw failed step, as material for the repair. */
  raw: unknown;
};

/**
 * Repairs a failed step, returning `null` when it cannot be repaired (the
 * explanation then ends with `error`). The implementation calls the LLM, but
 * this layer does not know that — in tests it is just a function.
 */
export type StepRepair = (rejection: BoardStepRejection) => Promise<unknown>;

/**
 * Repairs an out-of-scope heading, returning `null` when it cannot be. As with
 * {@link StepRepair}, this layer knows nothing about the LLM call.
 */
export type HeadRepair = (rejection: BoardHeadRejection) => Promise<unknown>;

/**
 * Which board elements each subject may use.
 *
 * The contract holds every expressible shape, but the usable branches differ by
 * subject. Allowing `latex` in an English lesson has senpai putting English
 * sentences into a formula block, only to be rejected later by `latex-guard`'s
 * ban on full-width characters and sent back for a redo. Closing it here means
 * English curricula never reach the LaTeX checks at all.
 */
const boardKindsBySubject: Record<CurriculumSubject, readonly string[]> = {
  math: ["latex", "text", "plot", "triangle", "circle", "figure"],
  english: ["sentence", "compare", "text"],
};

/**
 * The instruction when the contract is not met. LaTeX's per-reason wording lives
 * in guardrail.
 *
 * `null` is never offered as an escape. It used to say "one of these, or null",
 * which teaches that deleting the rejected board passes validation — and makes
 * that the cheapest path. A repaired step that becomes voice-only leaves the
 * lesson running to the end with a blank board, and since the delivery layer
 * sees only successes, nothing is recorded anywhere (the "board not rendering"
 * report of 2026-08-12 came through here, on steps whose figure had failed).
 * `null` is right only for narrowing questions, and that belongs to the prompt
 * body. Repair instructions always name where the content goes.
 */
const schemaGuidanceBySubject: Record<CurriculumSubject, Record<CurriculumLocale, string>> = {
  math: {
    ja: "手順の形が契約に合っていません。speech は120字以内の話し言葉(数式を入れない)、board は latex / text / plot / triangle / circle / figure のどれかにすること。figure の items に書けるキーは決まっていて、知らないキーは通りません。**board を null にして逃げないこと** — 書くはずだったものは、式なら latex、図なら figure、それでも書けなければ text の一行に置き換えて送ります。",
    en: "The step does not match the contract. Keep speech under 120 characters of plain spoken language (no formulas), and make board one of latex / text / plot / triangle / circle / figure. A figure's items accept a fixed set of keys — anything else is rejected. **Do not fall back to board: null** — put what you meant to write in latex, in figure, or failing that in a one-line text element.",
  },
  english: {
    ja: "手順の形が契約に合っていません。speech は120字以内の話し言葉、board は sentence(例文) / compare(2列の対比表) / text(一行の注記) のどれかにすること。**英語の板書に数式は置きません。** **board を null にして逃げないこと** — 書くはずだったものは sentence か text に置き換えて送ります。",
    en: "The step does not match the contract. Keep speech under 120 characters of plain spoken language, and make board one of sentence / compare / text. **Never put formulas on an English board.** **Do not fall back to board: null** — put what you meant to write in a sentence or text element instead.",
  },
};

/** The instruction when an element the subject cannot use arrives. */
const wrongKindGuidance: Record<CurriculumSubject, Record<CurriculumLocale, string>> = {
  math: {
    ja: "その要素は数学の板書では使えません。式は latex、図は figure(作図)か plot / triangle / circle、注記は text に置くこと。",
    en: "That element cannot be used on a maths board. Put formulas in latex, diagrams in figure (or plot / triangle / circle), and notes in text.",
  },
  english: {
    ja: "その要素は英語の板書では使えません。例文は sentence、使い分けの対比は compare、一行の注記は text に置くこと。数式は使いません。",
    en: "That element cannot be used on an English board. Put example sentences in sentence, contrasts in compare, and one-line notes in text. No formulas.",
  },
};

/**
 * The instruction for broken syntax. It states what to fix, not just what went
 * wrong (as with `latexRejectionGuidanceByLocale`: a reason alone gets the same
 * formula back).
 */
const syntaxGuidanceByLocale: Record<CurriculumLocale, string> = {
  ja: "数式の構文が壊れています。{ } が対応しているか、\\frac{分子}{分母} や \\sqrt{中身} のように引数を最後まで書いているかを確かめて、式を書き直すこと。",
  en: "The formula does not parse. Check that every { has a matching }, and that commands like \\frac{numerator}{denominator} and \\sqrt{...} have all of their arguments, then rewrite it.",
};

/**
 * Tier 3 of the three-tier check: actually parse with KaTeX.
 *
 * Tier 2 (`checkBoardLatex`) only inspects command and environment names, so a
 * broken formula built entirely from allowed commands — `\frac{1}{` — passes
 * straight through. On the device `flutter_math_fork` then cannot draw that line
 * and the board shows "cannot display formula"; a line vanishing mid-lesson is
 * worse than a slow one.
 *
 * `flutter_math_fork` is a Dart port of KaTeX, so running the original in Node
 * catches syntax errors up front. It does not replace tier 2 (KaTeX passing does
 * not mean the port supports it), so always run tier 2 first.
 *
 * `strict: "ignore"` because only syntax matters here. The `"warn"` default
 * writes to stderr for things like Unicode and pollutes the agent's logs, and
 * character classes were already settled by tier 2's `japaneseCharacters`.
 */
export function checkLatexSyntax(tex: string): { ok: true } | { ok: false; detail: string } {
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: false, strict: "ignore" });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type StepVerdict =
  | { ok: true; step: BoardStep }
  | { ok: false; rejection: BoardStepRejection };

/**
 * Validates one step: the last gate before it reaches the wire.
 *
 * `index` is overwritten with the position actually being sent, never the LLM's
 * claim. It is a delivery fact — which line of the board this goes on — and
 * mobile uses it alongside `seq` to detect gaps. Passing an LLM miscount through
 * makes the receiver judge a correctly delivered board as incomplete: a fixable
 * lie planted where the detection lives. The discrepancy is logged instead (the
 * calling {@link BoardChannel} picks it up).
 */
export function validateStep(
  raw: unknown,
  index: number,
  locale: CurriculumLocale,
  subject: CurriculumSubject = "math",
): StepVerdict {
  const withIndex =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw, index } : raw;

  const parsed = boardStepSchema.safeParse(withIndex);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(" / ");
    return {
      ok: false,
      rejection: {
        index,
        kind: "schema",
        reason: "schema",
        detail,
        guidance: `${schemaGuidanceBySubject[subject][locale]} (${detail})`,
        raw,
      },
    };
  }

  const board = parsed.data.board;

  // Elements the subject cannot use are rejected before their contents are
  // inspected: fixing LaTeX syntax on an English board is pointless.
  if (board !== null && !boardKindsBySubject[subject].includes(board.kind)) {
    return {
      ok: false,
      rejection: {
        index,
        kind: "schema",
        reason: "schema",
        detail: `kind=${board.kind} は ${subject} の板書では使えません`,
        guidance: wrongKindGuidance[subject][locale],
        raw,
      },
    };
  }

  // `focus` must be part of `text`. JSON Schema cannot carry this invariant, so
  // it is checked here; broken, it merely fails to draw an underline, which goes
  // unnoticed without a check.
  if (board !== null && board.kind === "sentence" && board.focus !== undefined) {
    if (!board.text.includes(board.focus)) {
      return {
        ok: false,
        rejection: {
          index,
          kind: "schema",
          reason: "schema",
          detail: `focus="${board.focus}" が text に含まれていません`,
          guidance:
            locale === "ja"
              ? "focus は text の中から、そのまま切り出した一部にすること(言い換えない)。"
              : "focus must be an exact substring of text — do not paraphrase it.",
          raw,
        },
      };
    }
  }

  if (board !== null && board.kind === "latex") {
    // Tier 2. A command the port cannot draw leaves that line blank or throws on
    // arrival, and a line vanishing mid-lesson is worse than a slow one.
    const verdict = checkBoardLatex(board.tex);
    if (!verdict.ok) {
      return {
        ok: false,
        rejection: {
          index,
          kind: "latex",
          reason: verdict.reason,
          detail: verdict.detail,
          guidance: latexRejectionGuidanceByLocale[locale][verdict.reason],
          raw,
        },
      };
    }

    // Tier 3, deliberately after tier 2: names first, then syntax.
    const syntax = checkLatexSyntax(board.tex);
    if (!syntax.ok) {
      return {
        ok: false,
        rejection: {
          index,
          kind: "syntax",
          reason: "syntax",
          detail: syntax.detail,
          guidance: syntaxGuidanceByLocale[locale],
          raw,
        },
      };
    }
  }

  if (board !== null && board.kind === "figure") {
    // Senpai writes only the relations; we solve them and produce coordinates and
    // SVG here. Unsolvable figures (an undefined point, the intersection of two
    // parallel lines, a length label that does not match) are rejected rather
    // than drawn — letting them through delivers a plausible-looking figure whose
    // contents are wrong. The reason doubles as the repair instruction, so it
    // joins the existing redo loop.
    const drawn = drawFigure(board.items);
    if (!drawn.ok) {
      return {
        ok: false,
        rejection: {
          index,
          kind: "figure",
          reason: "figure",
          detail: drawn.errors.join(" / "),
          guidance: figureGuidanceByLocale[locale](drawn.errors),
          raw,
        },
      };
    }
    if (drawn.svg.length > boardFigureSvgMaxLength) {
      // Drawable, but too dense for the board; have the figure split.
      return {
        ok: false,
        rejection: {
          index,
          kind: "figure",
          reason: "figure_too_large",
          detail: `svg ${drawn.svg.length} > ${boardFigureSvgMaxLength}`,
          guidance: figureTooLargeGuidanceByLocale[locale],
          raw,
        },
      };
    }
    return {
      ok: true,
      step: {
        ...parsed.data,
        board: { ...board, svg: drawn.svg, alt: describeFigure(board.items, locale) },
      },
    };
  }

  return { ok: true, step: parsed.data };
}

/**
 * The narration for a figure. SVG cannot be read aloud, so we produce one
 * sentence here.
 *
 * We hold the construction declaration, so the wording for `Semantics` can be
 * written on this side — the basis for judging narration a solved problem.
 */
function describeFigure(
  items: readonly Record<string, unknown>[],
  locale: CurriculumLocale,
): string {
  const has = (key: string) => items.some((item) => key in item);
  const parts: string[] = [];
  const word = (ja: string, en: string) => parts.push(locale === "en" ? en : ja);
  if (has("box3")) word("立体", "a solid");
  if (has("circle") || has("unitCircle")) word("円", "a circle");
  if (has("poly")) word("多角形", "a polygon");
  if (has("curve") || has("polar")) word("グラフ", "a graph");
  if (has("signTable")) word("増減表", "a sign table");
  if (has("states")) word("遷移図", "a transition diagram");
  if (has("boxplot") || has("histogram") || has("scatter")) word("データの図", "a data chart");
  if (has("vec")) word("ベクトル", "vectors");
  if (has("numberLine")) word("数直線", "a number line");
  const named = items
    .map((item) => item.pt)
    .filter((name): name is string => typeof name === "string")
    .slice(0, 6);
  const body =
    parts.length === 0
      ? locale === "en"
        ? "a figure"
        : "図"
      : parts.join(locale === "en" ? ", " : "と");
  const points =
    named.length === 0
      ? ""
      : locale === "en"
        ? ` with points ${named.join(", ")}`
        : `(点 ${named.join("・")})`;
  return `${body}${points}`.slice(0, boardFigureAltMaxLength);
}

/** Instruction when a figure could not be solved; the reason passes straight through, since senpai cannot fix what it cannot read. */
const figureGuidanceByLocale: Record<CurriculumLocale, (errors: readonly string[]) => string> = {
  ja: (errors) =>
    [
      `図が描けませんでした(${errors.join(" / ")})。`,
      "座標や長さを自分で計算せず、関係だけを書いてください。",
      "使う点は使う前に定義し、長さが決まっている図形は from と dist で置くこと。",
    ].join(""),
  en: (errors) =>
    [
      `The figure could not be drawn (${errors.join(" / ")}). `,
      "Do not compute coordinates or lengths yourself — declare the relations only. ",
      "Define every point before using it, and place fixed-length figures with from and dist.",
    ].join(""),
};

const figureTooLargeGuidanceByLocale: Record<CurriculumLocale, string> = {
  ja: "図が板書1枚には濃すぎます。要素を減らすか、2枚に分けてください。",
  en: "The figure is too dense for one board. Use fewer elements, or split it into two figures.",
};

/**
 * Why a heading was out of scope, in the same shape as a step's
 * {@link BoardStepRejection}.
 */
export type BoardHeadRejection = {
  reason: "topic_not_allowed";
  /** The offending `topic_id`. A closed curriculum vocabulary, so safe to log. */
  detail: string;
  /** The regeneration instruction, in the conversation's language; append as is. */
  guidance: string;
  /** The raw rejected heading, as material for the repair. */
  raw: unknown;
};

export type HeadVerdict = { ok: true } | { ok: false; rejection: BoardHeadRejection };

/** Instruction for an out-of-scope topic; a reason alone gets the same ID back. */
const topicGuidanceByLocale: Record<CurriculumLocale, (outside: string) => string> = {
  ja: (outside) =>
    [
      `topic_ids に、このセッションの許可リストに無い単元が入っています(${outside})。`,
      "許可リストの中から選び直し、板書の中身もその範囲で組み立て直すこと。",
      "リストには今回の主題とその前提が入っているので、前提に戻るのは構いません。",
    ].join(""),
  en: (outside) =>
    [
      `topic_ids contains a unit that is not in the allowed list for this session (${outside}). `,
      "Pick again from the allowed list, and rebuild the board within that range. ",
      "The list already contains this lesson's target plus its prerequisites, so going back to a prerequisite is fine.",
    ].join(""),
};

/**
 * Whether the heading's `topic_ids` fall within what this session may teach.
 *
 * Without this, the board is only half the guardrail. The README describes
 * whitelisting output `topic_id`s server-side and regenerating what falls
 * outside — a double guardrail — and the karte side has `filterHoleTopicIds`.
 * The contract's `topicIdSchema` checks only the format, so a well-formed ID for
 * a different topic passes straight through.
 *
 * The plan repurposes topic_id matching as a check on the validity of what is
 * being taught, and the board is exactly that. After the pivot, the thing the
 * guardrail should point at was the least protected.
 *
 * It is checked at the heading, before a single step is sent, so a rejection
 * leaves nothing on screen. Once steps are going out, something unerasable is
 * already in front of the student.
 */
export function validateHead(
  raw: unknown,
  allowed: AllowedTopics,
  locale: CurriculumLocale,
): HeadVerdict {
  const topicIds = (raw as { topic_ids?: unknown } | null)?.topic_ids;
  // Malformed values are not rejected here: the envelope schema
  // (`boardOpenMessageSchema`) checks them, and judging twice risks disagreement.
  if (!Array.isArray(topicIds)) return { ok: true };

  const outside = topicIds.filter(
    (id): id is string => typeof id === "string" && !isAllowedTopic(allowed, id),
  );
  if (outside.length === 0) return { ok: true };

  return {
    ok: false,
    rejection: {
      reason: "topic_not_allowed",
      detail: outside.join(", "),
      guidance: topicGuidanceByLocale[locale](outside.join(", ")),
      raw,
    },
  };
}

export type BoardChannelOptions = {
  sessionId: string;
  locale: CurriculumLocale;
  sink: BoardSink;
  /**
   * Topics this session may teach, used to match the heading
   * ({@link validateHead}).
   *
   * `backend/api` already includes two levels of prerequisites
   * (`conversationPrerequisiteDepth`), so it is not widened again here (the same
   * reason `karte.ts` builds with `prerequisiteDepth: 0`).
   *
   * Omitting it skips the match — an escape for tests and paths where the scope
   * is unavailable.
   */
  allowedTopicIds?: readonly string[];
  /**
   * Mints the `board_id`, so tests can inject a fixed value.
   *
   * The default is a UUID; the contract only requires `z.string().min(1)`, so the
   * format is not part of it. The fixtures' ULID-like `brd_01J8Z9...` is a sample
   * from `backend/api`'s `newId()`, which lives in another package the agent
   * cannot import. Pass a function here if time-ordered IDs are wanted.
   */
  newBoardId?: () => string;
  log?: Pick<JobLogger, "info" | "warn">;
};

/** How it closes, taken from the contract enum; copying it here would drift. */
export type BoardCloseReason = Extract<BoardChannelMessage, { type: "board_close" }>["reason"];

/**
 * An envelope body minus the parts the channel fills in (`v`, `session_id`,
 * `seq`). The shape exists so callers cannot write `seq` — the running number
 * belongs to the channel alone.
 */
type BoardEnvelopeBody =
  | { type: "board_open"; board_id: string; title: string; topic_ids: string[] }
  | { type: "board_step"; board_id: string; step: BoardStep }
  | { type: "board_close"; board_id: string; step_count: number; reason: BoardCloseReason };

export type AppendBoardOptions = {
  /** The LLM's output; chunks may split anywhere, even inside a string or escape. */
  chunks: AsyncIterable<string>;
  /**
   * The user's interruption. Aborting stops this explanation partway — the point
   * of streaming. It races `next()` so it works while awaiting a chunk; polling
   * alone would miss it whenever the LLM goes quiet.
   *
   * The board is not closed. An interruption means "I have a question now", not
   * "this problem is over". Closing here would reopen the board when the same
   * problem resumes, erasing what the student is reading. Only the caller's
   * {@link BoardDelivery.close} closes it, when the problem ends.
   */
  signal?: AbortSignal;
  /**
   * Called right after one step is sent. It is the hook that keeps board before
   * voice, and callers hand `step.speech` to TTS here.
   *
   * The next step is not sent until it returns, so what is awaited here becomes
   * the synchronization granularity:
   *
   *   - hand to TTS and return at once -> the board runs ahead of the voice.
   *     Regeneration waits are absorbed by that lead, but step-level
   *     synchronization loosens.
   *   - wait until speech finishes -> step-level synchronization holds, but a
   *     regeneration round trip surfaces as silence (see design decision 2).
   *
   * Which to take is undecided; it is a value to set after dogfooding shows how
   * many lines ahead of the voice the board can run before it becomes hard to
   * read.
   */
  onStep?: (step: BoardStep) => void | Promise<void>;
  /**
   * Decides, after each step, whether the explanation stops there.
   *
   * The board prompt says to end the board once a question is asked and not to
   * continue `steps`, because writing the next step before hearing the answer is
   * filling in your own answer and moving on — worse than asking them to
   * self-report. Nothing in the delivery layer enforced it, so an output that
   * ignored it read twelve steps including the question in one breath: senpai
   * answering their own question while talking on (the "turn taking is not being
   * held" report of 2026-08-12).
   *
   * Stopping is `completed`, not `interrupted`: the student did not interrupt,
   * senpai handed over the turn as planned, so this explanation is complete.
   *
   * What counts as handing over the turn is not decided here — that is a language
   * question and this layer knows no language (`handsTurnToStudent` in
   * `senpai.ts` owns it).
   */
  stopAfter?: (step: BoardStep) => boolean;
  repair?: StepRepair;
  /**
   * Has the heading redone when a board would start on an out-of-scope topic.
   *
   * A failed repair does not stop the board: it is recorded as a degradation and
   * proceeds (see the explanation inside `append`). As with `repair`, this layer
   * knows nothing about the LLM call.
   */
  repairHead?: HeadRepair;
  /** Retry limit per step; 0 disables regeneration. */
  maxRepairAttempts?: number;
};

export type BoardAppendResult = {
  board_id: string;
  /** Whether `board_open` was sent; if not, no step has gone out. */
  opened: boolean;
  /** Steps this call put on the wire. */
  appended: number;
  /** The board's total, which becomes `board_close.step_count`. */
  step_count: number;
  /** How this call ended. Even on `error` the board stays open; see `closed`. */
  reason: BoardCloseReason;
  /** Whether the board itself closed; true only on hitting the step limit. */
  closed: boolean;
  /** Steps that failed validation, repaired ones included; prompt-tuning material. */
  rejections: BoardStepRejection[];
};

/** The abort marker, raced against `iterator.next()`. */
const aborted = Symbol("aborted");

/**
 * The board channel for one session.
 *
 * `seq` lives here. By contract it is a running number within the session (from
 * 0, incrementing across message kinds), so it continues across boards.
 * Resetting it per board makes the receiver see the second `board_open` as a
 * rewind.
 *
 * A single board's lifetime belongs to {@link BoardDelivery}. The channel knows
 * only which room to send to and in what order, never what is being taught.
 */
export class BoardChannel {
  // No parameter properties on the constructor (`node --experimental-strip-types`,
  // ADR 0002).
  private readonly sessionId: string;
  private readonly locale: CurriculumLocale;
  /**
   * The lesson's subject. It follows from the allowed topics' prefix (ADR 0007),
   * so callers need not track it separately. The default is `math`, as when that
   * was the only subject.
   */
  private readonly subject: CurriculumSubject;
  private readonly sink: BoardSink;
  private readonly allowedTopics: AllowedTopics | undefined;
  private readonly newBoardId: () => string;
  private readonly log: Pick<JobLogger, "info" | "warn"> | undefined;
  private seq = 0;

  constructor(options: BoardChannelOptions) {
    this.sessionId = options.sessionId;
    this.locale = options.locale;
    this.subject =
      (options.allowedTopicIds?.[0] === undefined
        ? undefined
        : subjectOfTopicId(options.allowedTopicIds[0])) ?? "math";
    this.sink = options.sink;
    // Prerequisites are already included by the API, so no widening here (depth 0).
    this.allowedTopics =
      options.allowedTopicIds === undefined
        ? undefined
        : buildAllowedTopics(options.allowedTopicIds, { prerequisiteDepth: 0 });
    this.newBoardId = options.newBoardId ?? (() => `brd_${crypto.randomUUID()}`);
    this.log = options.log;
  }

  /** The `seq` of the next envelope, for tests and cross-checking. */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * Starts one board. The unit is one problem, not one explanation.
   *
   * Nothing is sent yet: `board_open` goes out from the first
   * {@link BoardDelivery.append}, using the `title` / `topic_ids` the LLM
   * produced — the heading says which problem it is, so only the LLM looking at
   * the problem can write it.
   */
  startBoard(): BoardDelivery {
    return new BoardDelivery({
      boardId: this.newBoardId(),
      locale: this.locale,
      subject: this.subject,
      allowedTopics: this.allowedTopics,
      log: this.log,
      send: (body) => this.sendEnvelope(body),
    });
  }

  /**
   * Sends one envelope, filling in `v`, `session_id` and `seq`.
   *
   * It validates itself against the envelope schema immediately before sending.
   * Delivery-layer bugs (a mis-assigned `seq`, the wrong board ID) look fine to
   * the transport, so nothing catches them unless they are caught here.
   *
   * `seq` advances only after a successful send. Consuming a number on a failed
   * envelope makes the receiver see a board with one message missing and takes
   * the following steps down with it.
   */
  private async sendEnvelope(body: BoardEnvelopeBody): Promise<void> {
    const validated = boardChannelMessageSchema.parse({
      v: boardProtocolVersion,
      session_id: this.sessionId,
      seq: this.seq,
      ...body,
    });
    await this.sink.send(validated);
    this.seq += 1;
  }
}

type BoardDeliveryOptions = {
  boardId: string;
  locale: CurriculumLocale;
  /** The lesson's subject; omitted, it is maths, as when that was the only one. */
  subject?: CurriculumSubject;
  allowedTopics: AllowedTopics | undefined;
  log: Pick<JobLogger, "info" | "warn"> | undefined;
  send: (body: BoardEnvelopeBody) => Promise<void>;
};

/**
 * One board = one problem.
 *
 * Its lifecycle is `append()` x n, then `close(reason)`. `board_open` is sent
 * once by the first `append()`, and later explanations stack on the same
 * `board_id`.
 *
 * `append()` never closes the board. Whether an explanation is interrupted or
 * fails validation, the board stays open awaiting the next one. That is how
 * "earlier lines are never erased; only moving to another problem clears them"
 * survives delivery-layer failures: closing after one failed explanation would
 * mean reopening for the next, and the formula the student was reading would
 * vanish at a moment they cannot account for.
 *
 * The one exception is hitting the step limit. Leaving open a board that cannot
 * take another step has the caller calling the LLM into a black hole, so that
 * one closes and stops.
 */
export class BoardDelivery {
  private readonly boardId: string;
  private readonly locale: CurriculumLocale;
  /** The lesson's subject, deciding which board elements may be used. */
  private readonly subject: CurriculumSubject;
  private readonly allowedTopics: AllowedTopics | undefined;
  private readonly log: Pick<JobLogger, "info" | "warn"> | undefined;
  private readonly send: (body: BoardEnvelopeBody) => Promise<void>;

  private opened = false;
  private closed = false;
  /** Steps sent on this board; the wire `index` is this, not the LLM's claim. */
  private sent = 0;

  constructor(options: BoardDeliveryOptions) {
    this.boardId = options.boardId;
    this.locale = options.locale;
    this.subject = options.subject ?? "math";
    this.allowedTopics = options.allowedTopics;
    this.log = options.log;
    this.send = options.send;
  }

  get id(): string {
    return this.boardId;
  }

  /** Steps sent on this board, which is also the next step's `index`. */
  get stepCount(): number {
    return this.sent;
  }

  /**
   * `board_open` sent and not yet closed.
   *
   * To ask whether more can be appended, read {@link isClosed} instead. Right
   * after starting a board, `board_open` has not gone out (the heading comes from
   * the LLM's first output), so `isOpen` is false — and `append()` still works
   * perfectly well.
   */
  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /** After closing. While true, `append()` puts nothing on the wire. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Appends one explanation to the same board.
   *
   * It consumes the stream and sends each step as it closes. Only the first call
   * emits `board_open`; later calls discard the `title` / `topic_ids` the LLM
   * attaches, because reopening there would erase the board.
   */
  async append(options: AppendBoardOptions): Promise<BoardAppendResult> {
    const {
      chunks,
      signal,
      onStep,
      stopAfter,
      repair,
      repairHead,
      maxRepairAttempts = defaultMaxRepairAttempts,
    } = options;

    const rejections: BoardStepRejection[] = [];
    const before = this.sent;
    let reason: BoardCloseReason = "completed";
    /**
     * Whether we stepped down deliberately via
     * {@link AppendBoardOptions.stopAfter}.
     *
     * Needed to distinguish this from truncated output
     * (`board_stream_truncated`): here we chose not to read the rest, and nothing
     * is broken.
     */
    let handedOver = false;

    if (this.closed) {
      // Appending to a board closed at the limit. Callers may not know, so this
      // returns "could not append" rather than throwing (voice carries on).
      this.log?.warn("board_append_after_close", { board_id: this.boardId, step_count: this.sent });
      return this.result({ reason: "error", before, rejections });
    }

    const parser = new BoardLessonStreamParser();
    /** Holding area for steps that closed before the heading arrived. */
    const pending: unknown[] = [];
    /** Position within this call; this is what the LLM's claim is compared to. */
    let position = 0;
    /**
     * The heading. Receiving it does not send `board_open` (see `openIfNeeded`);
     * that waits until the first step passes validation.
     */
    let head: { title: unknown; topic_ids: unknown } | null = null;

    const iterator = chunks[Symbol.asyncIterator]();

    try {
      consume: while (true) {
        const next = await nextOrAbort(iterator, signal);
        if (next === aborted) {
          reason = "interrupted";
          break;
        }
        if (next.done === true) break;

        for (const event of parser.feed(next.value)) {
          if (event.type === "lesson_head") {
            // Later headings are discarded; reopening here would erase the board.
            if (this.opened) {
              this.log?.info("board_head_ignored", {
                board_id: this.boardId,
                title: event.title,
              });
              continue;
            }
            head = await this.settleHead(
              { title: event.title, topic_ids: event.topic_ids },
              repairHead,
              maxRepairAttempts,
            );
            continue;
          }
          pending.push(event.raw);
        }

        // No step can go out before the heading (`board_open` comes first).
        if (head === null && !this.opened) continue;

        while (pending.length > 0) {
          if (signal?.aborted === true) {
            reason = "interrupted";
            break consume;
          }

          // The per-board limit. Reaching it closes the board (handled after the
          // finally below): nothing more can be appended, and leaving it open has
          // the caller calling the LLM into a black hole.
          if (this.sent >= boardStepsMaxCount) {
            this.log?.warn("board_steps_overflow", {
              board_id: this.boardId,
              step_count: this.sent,
            });
            reason = "error";
            break consume;
          }

          // The per-output limit, closing the loophole of streaming a whole worked
          // answer as "one line at a time, but forty lines"
          // (`boardLessonStepsMaxCount` in the contract) before it is sent. The
          // board is not closed; the next explanation can still append to it.
          if (position >= boardLessonStepsMaxCount) {
            this.log?.warn("board_lesson_overflow", {
              board_id: this.boardId,
              appended: this.sent - before,
            });
            reason = "error";
            break consume;
          }

          const raw = pending.shift();
          const verdict = await this.settleStep({
            raw,
            index: this.sent,
            position,
            repair,
            maxRepairAttempts,
            rejections,
          });

          if (!verdict.ok) {
            // Not repaired. Only this explanation stops; the board stays open
            // awaiting the next one (closing would erase it next time).
            this.log?.warn("board_step_rejected", {
              board_id: this.boardId,
              index: verdict.rejection.index,
              reason: verdict.rejection.reason,
              detail: verdict.rejection.detail,
            });
            reason = "error";
            break consume;
          }

          // Open the board only once a step is settled. `board_open` is the signal
          // that clears the previous board, so sending it for an output with no
          // steps (`steps: []`), or one whose first step fails validation, would
          // blank the board the student was reading and nothing else. Delaying by
          // one step costs only a few hundred ms on the heading.
          await this.openIfNeeded(head);

          await this.send({
            type: "board_step",
            board_id: this.boardId,
            step: verdict.step,
          });
          this.sent += 1;
          position += 1;

          // Board before voice. Awaiting here is deliberate: voice overtaking the
          // board makes "look here" point at an empty surface.
          await onStep?.(verdict.step);

          // Stop once the turn is handed over. It is checked after speaking
          // because the question itself must reach the student in full.
          if (stopAfter?.(verdict.step) === true) {
            this.log?.info("board_turn_handed_over", {
              board_id: this.boardId,
              index: verdict.step.index,
            });
            handedOver = true;
            break consume;
          }
        }
      }

      // The root `}` was never reached, so the output was truncated. The steps
      // sent are valid, but this is not "the whole explanation was sent", so it is
      // not `completed`. Deliberately stepping down is different: we chose not to
      // read the rest and nothing is broken.
      if (reason === "completed" && !handedOver && !parser.completed) {
        this.log?.warn("board_stream_truncated", {
          board_id: this.boardId,
          appended: this.sent - before,
        });
        reason = "error";
      }

      // Read to the end but appended nothing: the output violated the contract.
      // `boardLessonSchema` requires at least one entry in `steps`, so "read fully
      // but empty" is not success. Nothing reaches the receiver either way, but
      // returning success would have the caller believe a board went out and carry
      // on in voice alone.
      if (reason === "completed" && this.sent === before) {
        this.log?.warn(head === null ? "board_head_missing" : "board_lesson_empty", {
          board_id: this.boardId,
          opened: this.opened,
        });
        reason = "error";
      }
    } catch (error) {
      // A parse failure (`BoardStreamError`), an envelope contract violation, or a
      // send failure. None get better by waiting, and the board is still alive.
      reason = "error";
      this.log?.warn("board_append_failed", {
        board_id: this.boardId,
        appended: this.sent - before,
        stream_error: error instanceof BoardStreamError,
        message: error instanceof Error ? error.message : String(error),
      });
      releaseIterator(iterator);
    }

    // Release the upstream, handing over the turn included: we chose not to read
    // the remaining steps, so holding the connection keeps paying for output
    // tokens nobody will hear (`createAnthropicLessonClient` in `lesson.ts` drops
    // the HTTP connection).
    if (reason === "interrupted" || handedOver) releaseIterator(iterator);

    // Only a board at the step limit closes here.
    if (this.opened && !this.closed && this.sent >= boardStepsMaxCount) {
      await this.close("error");
    }

    return this.result({ reason, before, rejections });
  }

  /**
   * Sends `board_open` if not already open. Called once the first step settles.
   *
   * For why it is not sent when the heading arrives, see the call site: an empty
   * output must not blank the student's board.
   */
  private async openIfNeeded(head: { title: unknown; topic_ids: unknown } | null): Promise<void> {
    if (this.opened || head === null) return;
    await this.send({
      type: "board_open",
      board_id: this.boardId,
      // The envelope schema checks the types. A bad value from the LLM fails here
      // and the board does not open, which beats opening a broken one.
      title: head.title as string,
      topic_ids: head.topic_ids as string[],
    });
    this.opened = true;
    this.log?.info("board_opened", { board_id: this.boardId, title: head.title });
  }

  /**
   * Closes the board. Called when the problem ends, not when one explanation does.
   *
   * If `board_open` was never sent, nothing is sent: the receiver discards a
   * `board_close` for an unopened board, so it only wastes a `seq`. A second call
   * does nothing (a duplicate close is a contract violation on the receiver).
   *
   * A failed send does not count as closed. To the receiver the board is still
   * open, and it rejects the next problem's `board_open` with "the previous board
   * was not closed" — one failed send would stop every later board in the session
   * from appearing. The failure is kept in state so the caller can close again
   * (`send` advances `seq` only on success, so retrying skips no numbers).
   */
  async close(reason: BoardCloseReason): Promise<void> {
    if (this.closed) return;
    if (!this.opened) {
      this.closed = true;
      return;
    }

    try {
      // `step_count` is what was actually sent for this board; it is the only way
      // to detect a lost tail.
      await this.send({
        type: "board_close",
        board_id: this.boardId,
        step_count: this.sent,
        reason,
      });
      this.closed = true;
    } catch (error) {
      this.log?.warn("board_close_failed", {
        board_id: this.boardId,
        step_count: this.sent,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private result(input: {
    reason: BoardCloseReason;
    before: number;
    rejections: BoardStepRejection[];
  }): BoardAppendResult {
    return {
      board_id: this.boardId,
      opened: this.opened,
      appended: this.sent - input.before,
      step_count: this.sent,
      reason: input.reason,
      closed: this.closed,
      rejections: input.rejections,
    };
  }

  /**
   * Settles the heading, repairing it if needed. A rejection never stops the
   * board.
   *
   * Starting on an out-of-scope topic means teaching something not in the photo,
   * so it is repaired. But a failed repair must not kill the board — the student
   * would lose a whole 15-minute lesson, and a slightly off-scope board beats no
   * board. So it ultimately returns the original heading and proceeds, recording
   * the degradation in the log.
   *
   * With no allowed set it passes through (tests, and paths where the scope is
   * unavailable).
   */
  private async settleHead(
    head: { title: unknown; topic_ids: unknown },
    repairHead: HeadRepair | undefined,
    maxRepairAttempts: number,
  ): Promise<{ title: unknown; topic_ids: unknown }> {
    const allowed = this.allowedTopics;
    if (allowed === undefined) return head;

    let candidate: { title: unknown; topic_ids: unknown } = head;

    for (let attempt = 0; ; attempt += 1) {
      const verdict = validateHead(candidate, allowed, this.locale);
      if (verdict.ok) return candidate;

      this.log?.warn("board_topics_rejected", {
        board_id: this.boardId,
        // Out-of-scope IDs come from a closed vocabulary; if frequent, they are
        // material for fixing the prompt.
        reason: verdict.rejection.reason,
        detail: verdict.rejection.detail,
        attempt,
      });

      if (repairHead === undefined || attempt >= maxRepairAttempts) return head;

      let repaired: unknown;
      try {
        repaired = await repairHead(verdict.rejection);
      } catch {
        return head;
      }
      if (repaired === null || repaired === undefined) return head;
      if (typeof repaired !== "object" || Array.isArray(repaired)) return head;
      candidate = repaired as { title: unknown; topic_ids: unknown };
    }
  }

  /**
   * Settles one step, repairing it if needed. A failed step never leaves here —
   * the caller only sends `ok` ones.
   */
  private async settleStep(input: {
    raw: unknown;
    /** The `index` that goes on the wire (the running number within the board). */
    index: number;
    /** Position within this call; this is what the LLM's claim is compared to. */
    position: number;
    repair: StepRepair | undefined;
    maxRepairAttempts: number;
    rejections: BoardStepRejection[];
  }): Promise<StepVerdict> {
    const { raw, index, position, repair, maxRepairAttempts, rejections } = input;
    let candidate = raw;

    for (let attempt = 0; ; attempt += 1) {
      const verdict = validateStep(candidate, index, this.locale, this.subject);
      if (verdict.ok) {
        this.warnIfIndexMoved(candidate, position, index);
        return verdict;
      }

      rejections.push(verdict.rejection);
      if (repair === undefined || attempt >= maxRepairAttempts) return verdict;

      try {
        const repaired = await repair(verdict.rejection);
        if (repaired === null || repaired === undefined) return verdict;
        candidate = repaired;
      } catch {
        // If the repairer itself fails, do not persist (voice carries on).
        return verdict;
      }
    }
  }

  /**
   * Records only the fact that the LLM miscounted.
   *
   * It is compared against `position` (the place within that output), never the
   * wire `index`. The LLM does not know which call it is on, so on the second
   * explanation it always counts from 0 — which is correct behaviour, and being
   * out of step with the wire's running number is expected. Comparing against the
   * wire here would warn on every step from the second explanation on and bury
   * real miscounts.
   */
  private warnIfIndexMoved(raw: unknown, position: number, index: number): void {
    if (typeof raw !== "object" || raw === null) return;
    const declared = (raw as { index?: unknown }).index;
    if (typeof declared === "number" && declared !== position) {
      this.log?.warn("board_step_index_overridden", { declared, position, index });
    }
  }
}

/**
 * The default repair count: one.
 *
 * It was two until one step's audio turned out to be 2-5 seconds (measured
 * above), which stopped paying:
 *
 *   - one regeneration (a few seconds) feels like the space of one step, within
 *     the range that reads as a breath
 *   - two exceeds a whole step's worth of silence, a length this app has already
 *     treated as a bug (`closingGraceMs = 2500` is the minimum padding for "it
 *     did not sound cut off", the inverse of 2.5 seconds passing unnoticed)
 *   - and the second attempt gets the same material as the first.
 *     `latexRejectionGuidanceByLocale` is fixed wording per reason, right down to
 *     where the content should go ("send it as a `text` board"). Failing the
 *     first time means the phrasing does not respond to that instruction, and
 *     repeating it lands in the same family of failures. There is no reason to
 *     pay a step's worth of silence for a retry carrying no new information.
 *
 * Callers can override with `maxRepairAttempts`. If the instructions ever branch
 * so the second attempt says something different, two becomes worth restoring.
 */
export const defaultMaxRepairAttempts = 1;

/**
 * Returns whichever arrives first: the next chunk or an abort.
 *
 * Not `for await` polling, because that misses an interruption whenever the LLM
 * goes quiet. Noticing an interruption "when the next chunk arrives" is too
 * late — the student is already talking.
 */
async function nextOrAbort(
  iterator: AsyncIterator<string>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<string> | typeof aborted> {
  if (signal === undefined) return iterator.next();
  if (signal.aborted) return aborted;

  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<typeof aborted>((resolve) => {
    onAbort = () => resolve(aborted);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  // If the abort wins, this next() is left with nobody awaiting it. Failing later
  // would take the process down as an unhandled rejection, so it is handled up
  // front.
  const next = iterator.next();
  next.catch(() => undefined);

  try {
    return await Promise.race([next, interrupted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Releases the upstream (the LLM's stream).
 *
 * It does not wait. When leaving on an interruption the upstream may be parked
 * mid-`await`, and calling `return()` on an async generator in that state does
 * not come back until that await resolves — never, if the LLM stays quiet.
 * Waiting here would stop `board_close` being sent, the very point of the
 * interruption: the student is already talking and the board never closes.
 * Cleanup is best effort.
 */
function releaseIterator(iterator: AsyncIterator<string>): void {
  iterator.return?.().catch(() => undefined);
}
