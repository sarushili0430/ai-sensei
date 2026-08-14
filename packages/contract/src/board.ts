import { figureItemsSchema } from "@ai-sensei/figure";
import { z } from "zod";
import { topicIdSchema } from "./karte.ts";

/**
 * The contract for the board (the lines the senpai stacks on screen).
 *
 * Design promises (grounded in pivot plan v1 §3-1; implementations that break
 * them are rejected):
 *   - Formulas, working and figures go on the board; speech is only questions and
 *     connective tissue. This is not about looks but a main cost driver: TTS
 *     characters are the bill. So "speak briefly" is enforced by a schema limit
 *     ({@link boardSpeechMaxLength}), not by asking the prompt nicely.
 *   - No freehand drawing. The LLM emits parameters only, and neither LLM-written
 *     SVG nor canvas commands enter through any branch. `figure` carries SVG, but
 *     it is what we solved and drew from validated `items` (declared relations,
 *     {@link figureElementSchema}). `items`'s vocabulary is closed by
 *     `@ai-sensei/figure`, and coordinates, lengths and ratios are computed rather
 *     than written, so an inconsistent figure cannot be produced.
 *   - A whole worked answer cannot be poured into one element. The board is
 *     "one step = one line", not a place to paste an answer sheet. It is bound both
 *     by the `tex` / `body` limits and by a per-output step cap
 *     ({@link boardLessonStepsMaxCount}).
 *   - Coordinates are finite and fit the surface. `Infinity` or 1e300 silently
 *     breaks the Flutter side.
 *
 * This file holds two shapes, deliberately separated because their
 * responsibilities differ:
 *
 *   1. What the LLM emits ({@link boardLessonSchema}) - one explanation's worth,
 *      received by the agent as structured output. The streaming JSON is parsed
 *      incrementally and, once `steps[i]` closes, that single step is validated
 *      with {@link boardStepSchema}. The LLM does not know which room or which
 *      message number this is, and does not need to: mixing session identifiers
 *      into LLM output lets hallucinated ids reach the delivery layer. It is not
 *      told which explanation this is either - give it a running number and
 *      hallucinated numbers reach the wire.
 *
 *   2. What flows on the data channel ({@link boardChannelMessageSchema}) - the
 *      envelope that carries one step at a time to mobile over LiveKit's data
 *      channel. It has a destination (session_id), which board (board_id) and
 *      ordering (seq / index). Delivery concerns (ordering, gap detection, board
 *      switching) are entirely this side's responsibility and never leak into the
 *      LLM's output format.
 *
 * Synchronization is at step granularity, not milliseconds (§3-2). The front end
 * stacks lines in receive order and never erases earlier ones. They are erased
 * only on {@link boardOpenMessageSchema} (= moving to another problem).
 */

/**
 * The cap on `speech`, derived from Japanese TTS speaking rate (~330 chars/min).
 *
 *   120 chars / 330 chars/min ~= 22s -> 20-25 seconds per step.
 *
 * It enforces "speech is only questions and connective tissue" (§3-1) in the
 * schema rather than in prompt wording. Loosen it and TTS cost grows linearly,
 * erasing the 5,000 yen/month margin (§6-2). Reading a formula aloud always
 * exceeds 120 characters, so the cap itself checks the principle.
 */
export const boardSpeechMaxLength = 120;

/**
 * The cap on `latex`: a length that fits the screen width as one board line.
 * `x^2 - 3x + 2 = 0 \Rightarrow D = 9 - 8 = 1 > 0` is about 45 characters, so 200
 * is a loose line that only rejects "too long for one line". Pasting an answer
 * sheet is stopped by this cap, {@link boardLessonStepsMaxCount} and the ban on
 * multi-line environments (below).
 */
export const boardTexMaxLength = 200;

/** The cap on `text`: one heading or note beside the board ("a = 1, b = -3, c = 2"). */
export const boardTextMaxLength = 100;

/**
 * The cap on `sentence`'s English text and its gloss.
 *
 * Wider than `text`'s 100 because English carries less information per character
 * (the same reasoning as `spaced-repetition` cutting a review line at ja 24 /
 * en 48). 120 ASCII characters is two board lines, holding a sentence with a
 * subordinate clause such as `I have lived here for ten years, so I know the area
 * well.` Anything longer is a paragraph, not an example.
 */
export const boardSentenceMaxLength = 120;

/**
 * The cap on `sentence.gloss`. Shorter than the English is fine - Japanese
 * writes the same content in about half the characters.
 */
export const boardGlossMaxLength = 60;

/**
 * The cap on `sentence.focus`. It points at the grammatical focus only:
 * `have lived` / `to see` / `whose` - a word or phrase, not a clause.
 */
export const boardFocusMaxLength = 40;

/** The cap on one `compare` cell. A comparison table is a list, not an explanation. */
export const boardCompareCellMaxLength = 60;

/**
 * The cap on `compare` rows.
 *
 * Five or more rows is a handout, not a board (the same call as capping
 * {@link plotMarkSchema} at 4 and triangle marks at 3). Comparisons work at about
 * three rows - form / meaning / when to use - and beyond that nobody reads them.
 */
export const boardCompareRowsMaxCount = 4;

/** The cap on labels (vertex names, axis notes, table headings). One or two words is enough. */
export const boardLabelMaxLength = 24;

/**
 * The cap on `figure`'s SVG.
 *
 * Measured over the 39 figures in `docs/figeval/`: median 3.1KB, p90 7.3KB, max
 * 15.6KB. 16KB would pass them all, but a board lives for up to
 * {@link boardStepsMaxCount} steps on one problem, so anything that large is
 * treated as too dense for a board and cut at 12KB - the line where 38 of 39 fit.
 * Exceeding it is the signal to split the figure or revisit the vocabulary.
 */
export const boardFigureSvgMaxLength = 12_000;

/** The figure's spoken description. Used by screen readers and when it cannot be seen. */
export const boardFigureAltMaxLength = 200;

/**
 * The cap on how many steps the LLM may emit at once ({@link boardLessonSchema}'s
 * `steps`).
 *
 * A unit like the discriminant finishes in 6-8 steps. Without a cap the LLM can
 * pour a whole worked answer through as "one line at a time, but 40 lines" - the
 * loophole around the per-element caps. If one explanation exceeds this, it is an
 * answer sheet, not a board.
 *
 * This is not the per-board cap ({@link boardStepsMaxCount}). A board lives for
 * one problem, and several explanations stack onto the same board.
 */
export const boardLessonStepsMaxCount = 12;

/**
 * The cap on how many steps one board can hold. It bounds the wire's `index`
 * ({@link boardStepSchema}) and {@link boardCloseMessageSchema}'s `step_count`.
 *
 * A board lives for one problem, not one explanation (§3-2: "never erase earlier
 * lines; only a new problem clears them"). Reopening the board per LLM call
 * erases it once per exchange - losing the board's whole value.
 *
 * One problem runs 15-20 minutes (§4-1), with several rounds of explanation:
 *
 *   diagnose 2-3 steps + teach 5-8 steps + hand over to teach-back 1 step
 *   ~= 8-12 steps per round; getting stuck in teach-back means teaching again
 *   (the §2 core loop), so 2-3 rounds -> 16-36 steps
 *
 * 40 adds a little slack above that upper end (36). Reaching it means "40 lines
 * on one problem and still not done", which is a lesson-design problem rather
 * than a shortage of board space (the kind of breakage the §3-4 gate catches).
 * So this number is a cutoff safety valve, not a target or a recommendation.
 */
export const boardStepsMaxCount = 40;

/**
 * The cap on the absolute value of a board coordinate. A board is "a figure drawn
 * in a notebook on the spot", so astronomical coordinates never apply. Bound the
 * magnitude, not just finiteness.
 */
export const boardCoordinateLimit = 1000;

/** A coordinate on the board. Finite and within the surface. */
const coordinateSchema = z.number().finite().min(-boardCoordinateLimit).max(boardCoordinateLimit);

/**
 * A point on the board.
 *
 * The plan's draft wrote `Pt` as a tuple; this uses an `{x, y}` object. The file
 * is consistent about "objects for heterogeneous values, arrays for fixed-length
 * sequences of the same kind":
 *
 *   - `{x, y}` / `{min, max}` hold different meanings. Distinguishing them by
 *     position lets an LLM swap them and still pass validation (`domain: [4, -1]`
 *     is well-formed). Naming them makes the swap detectable.
 *   - `vertices`'s three points and `labels`'s three entries are the same kind,
 *     and order means nothing beyond "the first vertex". Those stay arrays
 *     (`z.tuple`). They survive in JSON Schema as `minItems`/`maxItems`, so the
 *     Dart side needs only `List<BoardPoint>` plus a length-3 check, readable
 *     from the reference.
 */
export const boardPointSchema = z.object({ x: coordinateSchema, y: coordinateSchema }).strict();
export type BoardPoint = z.infer<typeof boardPointSchema>;

/**
 * The kinds of element that can be stacked on the board. Adding one means adding
 * the Flutter rendering implementation at the same time.
 *
 * Which branches are usable differs by subject: math uses `latex` / `plot` /
 * `triangle` / `circle` / `figure`, English uses `sentence` / `compare`, and only
 * `text` works for both. Which are allowed is closed on the agent side
 * (`boardKindsBySubject`), not in the schema - contract defines what *can* be
 * expressed, while what is allowed *now* depends on context.
 */
export const boardElementKinds = [
  "latex",
  "text",
  "plot",
  "triangle",
  "circle",
  "sentence",
  "compare",
  "figure",
] as const;
export type BoardElementKind = (typeof boardElementKinds)[number];

/**
 * Must contain no multi-line LaTeX environment. Allowing `\begin{align}` breaks
 * "one step = one line" and becomes the loophole for pouring an answer sheet into
 * one element, so it is banned in the schema.
 *
 * `cases` and the `matrix` family are deliberately absent from the ban list, i.e.
 * they are allowed: case analysis reads naturally as one board line in high-school
 * math (plan §3-6's measured whitelist also permits `\begin{pmatrix}` and
 * `\begin{cases}`).
 *
 * This only checks the structural question of "is it one line". Whether
 * `flutter_math_fork` can render a command (the command whitelist, real parsing
 * with KaTeX) belongs to `packages/guardrail` and the agent (plan §3-6's three
 * stages). contract is a dependency-free layer and does not check contents (the
 * same split as `karte.ts`'s `topicIdSchema`).
 *
 * Written with `.regex()` rather than `.refine()`: refine leaves nothing in JSON
 * Schema, hiding this constraint from Dart implementers who treat `schema/*.json`
 * as the single reference (see the README's "invariants absent from JSON Schema").
 * The negative lookahead plus `[\s\S]` is used because `pattern` carries no flags:
 * `.` with the `s` flag would let a `tex` containing newlines slip through.
 */
const noMultilineLatexPattern =
  /^(?![\s\S]*\\begin\{(?:align|gather|eqnarray|array|split|multline)\*?\})[\s\S]*$/;

export const latexElementSchema = z
  .object({
    kind: z.literal("latex"),
    /**
     * A formula rendered by flutter_math_fork. One line's worth.
     *
     * A character cap does not guarantee display width (`\frac` only grows
     * vertically; `\sum_{k=1}^{n}` is short but wide). Long formulas not fitting
     * the real 340pt width is an open issue in plan §3-6b, and how this is bound
     * may change after measurement.
     */
    tex: z.string().min(1).max(boardTexMaxLength).regex(noMultilineLatexPattern, {
      message: "板書は1手順=1行。多行環境(align/gather/array...)は使えません",
    }),
  })
  .strict();

export const textElementSchema = z
  .object({
    kind: z.literal("text"),
    /** A line that is not a formula: heading, note, rephrasing. Not a place for prose. */
    body: z.string().min(1).max(boardTextMaxLength),
  })
  .strict();

/**
 * A mark plotted on a graph. Only the one point worth looking at - intersection,
 * vertex. Capped at 4; a figure needing five or more marks has become a handout.
 */
export const plotMarkSchema = z
  .object({
    at: boardPointSchema,
    label: z.string().min(1).max(boardLabelMaxLength).optional(),
  })
  .strict();
export type PlotMark = z.infer<typeof plotMarkSchema>;

/**
 * The shapes allowed in `fn`. The expression is evaluated on the device, so the
 * input shape is closed here: variable x, digits, the four operations, powers,
 * parentheses, and the listed function names. "The LLM emits parameters only"
 * (§3-3), applied to function expressions.
 *
 * Function names and the character class live in one regex because a two-stage
 * `.refine()` check leaves nothing in JSON Schema (same reason as
 * {@link noMultilineLatexPattern}). The only allowed letter is `x`, and every
 * function name contains a letter other than `x`, so at most one branch applies at
 * each position - no backtracking. Adding `e` (Euler's number) would make `exp`
 * ambiguous and cause exponential backtracking on failing input (zod evaluates the
 * regex without stopping at `.max()`). So `e^x` cannot be written; the prompt
 * requires `exp(x)`.
 */
const plotFunctionPattern = /^(?:sin|cos|tan|sqrt|abs|log|ln|exp|pi|[-+*/^().,0-9x\s])+$/;

export const plotElementSchema = z
  .object({
    kind: z.literal("plot"),
    /** An expression in x, e.g. `x^2 - 3*x + 2`. `*` is never omitted (parsers differ). */
    fn: z.string().min(1).max(80).regex(plotFunctionPattern, {
      message: "fn には x・数値・四則・^・括弧と、既定の関数名しか使えません",
    }),
    /**
     * The x range to draw. Changed from the draft's `[number, number]` to
     * `{min, max}` (see {@link boardPointSchema}).
     *
     * `min < max` cannot be expressed in JSON Schema (like
     * {@link boardChannelLogSchema}'s ordering rules), so the Dart side must add it
     * by hand. The README's "invariants absent from JSON Schema" lists them all.
     */
    domain: z
      .object({ min: coordinateSchema, max: coordinateSchema })
      .strict()
      .refine((domain) => domain.min < domain.max, {
        message: "domain は min < max",
        path: ["max"],
      }),
    marks: z.array(plotMarkSchema).max(4).optional(),
  })
  .strict();

/**
 * An angle mark on a triangle. `vertex` is an index into `vertices` (0-2).
 * Indices rather than vertex names, so marks work on unlabelled triangles too.
 */
export const angleMarkSchema = z
  .object({
    vertex: z.number().int().min(0).max(2),
    kind: z.enum(["angle", "right_angle"]),
    label: z.string().min(1).max(boardLabelMaxLength).optional(),
  })
  .strict();
export type AngleMark = z.infer<typeof angleMarkSchema>;

export const triangleElementSchema = z
  .object({
    kind: z.literal("triangle"),
    vertices: z.tuple([boardPointSchema, boardPointSchema, boardPointSchema]),
    /** Vertex names. If given, give all three (a triangle labelled only A and B is unreadable). */
    labels: z
      .tuple([
        z.string().min(1).max(boardLabelMaxLength),
        z.string().min(1).max(boardLabelMaxLength),
        z.string().min(1).max(boardLabelMaxLength),
      ])
      .optional(),
    marks: z.array(angleMarkSchema).max(3).optional(),
  })
  .strict();

export const circleElementSchema = z
  .object({
    kind: z.literal("circle"),
    center: boardPointSchema,
    /** The radius. 0 is not a circle, so it is rejected. */
    r: z.number().finite().positive().max(boardCoordinateLimit),
    /** Centre name, radius note, etc. Up to three. */
    labels: z.array(z.string().min(1).max(boardLabelMaxLength)).max(3).optional(),
  })
  .strict();

/**
 * The lead element of an English board: one example sentence with its gloss and
 * focus.
 *
 * `text` cannot substitute because of `focus`. English teaching is about "which
 * part of this sentence is the present perfect", not the sentence itself. Plain
 * lines leave the student skimming the example with no idea where to look.
 *
 * `gloss` is not required because withholding the translation is sometimes the
 * right teaching move (giving the meaning first removes the practice of deriving
 * meaning from grammar).
 */
export const sentenceElementSchema = z
  .object({
    kind: z.literal("sentence"),
    /** One English sentence. */
    text: z.string().min(1).max(boardSentenceMaxLength),
    /** Gloss or rephrasing. Optional, since withholding it is a valid teaching choice. */
    gloss: z.string().min(1).max(boardGlossMaxLength).optional(),
    /**
     * The part of `text` to underline. Must be a substring of `text`.
     *
     * That condition is not checked here. `boardElementSchema` is a
     * `discriminatedUnion`, whose branches must be `ZodObject`; adding `.refine()`
     * makes it a `ZodEffects`, which cannot join the union.
     *
     * Treated like `plot`'s `domain.min < max`: listed in the README's "invariants
     * absent from JSON Schema" and checked in both Dart's `ensureValidSentence` and
     * the agent's `validateStep`. When broken it merely shows as "no underline", so
     * without a check it would stay broken unnoticed for months.
     */
    focus: z.string().min(1).max(boardFocusMaxLength).optional(),
  })
  .strict();

/**
 * A comparison table: "present perfect vs past", "to-infinitive vs gerund".
 *
 * Fixed at two columns. Three or more is unreadable at phone width (an effective
 * 340pt ~= 30 ASCII characters), and English grammar comparisons are nearly always
 * a two-way distinction. Make the columns variable and the LLM starts using the
 * table as a handout.
 */
export const compareElementSchema = z
  .object({
    kind: z.literal("compare"),
    /** "to-infinitive vs gerund". The table reads fine without it. */
    title: z.string().min(1).max(boardLabelMaxLength).optional(),
    /** The two column headings. */
    columns: z.tuple([
      z.string().min(1).max(boardLabelMaxLength),
      z.string().min(1).max(boardLabelMaxLength),
    ]),
    /** Two cells per row. 1-4 rows. */
    rows: z
      .array(
        z.tuple([
          z.string().min(1).max(boardCompareCellMaxLength),
          z.string().min(1).max(boardCompareCellMaxLength),
        ]),
      )
      .min(1)
      .max(boardCompareRowsMaxCount),
  })
  .strict();

/**
 * A constructed figure. The senpai writes only `items` (declared relations).
 *
 * `svg` and `alt` are solved and filled in by the agent via `@ai-sensei/figure`.
 * An `svg` written by the senpai is discarded - letting it through would be
 * freehand drawing.
 *
 * `items` rides along for three reasons:
 *   - the guardrail can check what was drawn (SVG cannot be checked)
 *   - the device can redraw it later (the D-21 switch; SVG alone is one-way)
 *   - on failure it can be thrown straight back to the senpai
 *
 * The vocabulary belongs to `@ai-sensei/figure`. Only the shape is checked here;
 * unknown keys, off-board coordinates and names unusable in expressions are
 * rejected by {@link figureItemsSchema}.
 */
export const figureElementSchema = z
  .object({
    kind: z.literal("figure"),
    /** The figure declaration. Vocabulary and syntax in `docs/figeval/spec.md`. */
    items: figureItemsSchema,
    /**
     * The solved and drawn SVG. The device only renders this.
     * Absent from the senpai's output; the agent fills it in before delivery (hence `optional`).
     */
    svg: z.string().min(1).max(boardFigureSvgMaxLength).optional(),
    /** The figure's spoken description. Also filled in by the agent. */
    alt: z.string().min(1).max(boardFigureAltMaxLength).optional(),
  })
  .strict();

/**
 * One element stacked on the board. A discriminated union on `kind`.
 *
 * Freehand drawing exists in no branch. `figure` carries SVG, but that SVG is
 * {@link figureElementSchema | generated by us from validated `items`}, and there
 * is no path by which a senpai-written SVG gets through.
 */
export const boardElementSchema = z.discriminatedUnion("kind", [
  latexElementSchema,
  textElementSchema,
  plotElementSchema,
  triangleElementSchema,
  circleElementSchema,
  sentenceElementSchema,
  compareElementSchema,
  figureElementSchema,
]);
export type BoardElement = z.infer<typeof boardElementSchema>;

/**
 * Must contain no LaTeX command (`\` + letters). Used for `speech`.
 * Same reasoning and style as {@link noMultilineLatexPattern} (`.refine()` leaves nothing in JSON Schema).
 */
const noLatexCommandPattern = /^(?![\s\S]*\\[a-zA-Z])[\s\S]*$/;

/**
 * One step = "the senpai says one thing while adding one board line". Also the
 * granularity of synchronization.
 *
 * `speech` always has at least one character. Steps where the board grows in
 * silence are disallowed because (a) the user loses any opening to interrupt and
 * (b) the front end loses track of what to wait for next. When you want to write
 * silently, a short connective like "okay, here" suffices.
 */
export const boardStepSchema = z
  .object({
    /**
     * The running number within the board. Starts at 0 and increases by 1
     * (redundant gap detection).
     *
     * This schema is used in two contexts, and `index` counts over different
     * ranges in each:
     *
     *   - inside {@link boardLessonSchema} (what the LLM emits) = 0-based within
     *     that single output. The LLM does not know which call this is and is not
     *     told (a running number would put hallucinated numbers on the wire).
     *   - inside {@link boardStepMessageSchema} (the wire) = 0-based within one
     *     board. A board lives for one problem, so later explanations continue the
     *     previous numbering. Assigning that is the delivery layer's job.
     *
     * So the cap is the wider one ({@link boardStepsMaxCount}). That the LLM side
     * is stricter is guaranteed by the `steps` element count
     * ({@link boardLessonStepsMaxCount}) and the `index === position` check.
     */
    index: z
      .number()
      .int()
      .min(0)
      .max(boardStepsMaxCount - 1),
    /**
     * The line to read aloud. Questions and connective tissue only (§3-1).
     * A LaTeX command mixed in means something that belongs on the board is being
     * spoken. `$` is not checked because it appears as currency in English word
     * problems; only `\` + letters is. Symbols like `∠` and `°` are needed for
     * natural explanation and are re-read on the TTS side, so they are not
     * rejected - rejecting here would discard the step and it would never reach
     * the student.
     */
    speech: z.string().min(1).max(boardSpeechMaxLength).regex(noLatexCommandPattern, {
      message: "speech に数式(LaTeX)を入れないでください。数式は board に置きます",
    }),
    /** The element to stack. `null` means audio only (acknowledgement, confirmation). */
    board: boardElementSchema.nullable(),
  })
  .strict();
export type BoardStep = z.infer<typeof boardStepSchema>;

/**
 * What the LLM emits - one explanation's worth.
 *
 * The agent receives this as streaming JSON and, once `steps[i]` closes, validates
 * that single step with {@link boardStepSchema} and delivers it immediately
 * (without waiting for the rest; §3-2 option A). So validating this whole schema
 * is the final reconciliation, not the delivery gate.
 *
 * Note this is not "one board". A board (`board_id`) lives for one problem and is
 * built from several outputs of this shape. `title` / `topic_ids` appear every
 * time because the LLM does not know which call this is - only the first is used,
 * and the delivery layer discards the rest (reissuing `board_open` there would
 * erase the board).
 *
 * It deliberately has no session_id / board_id: identifiers are added by the
 * delivery layer (the envelope).
 */
export const boardLessonSchema = z
  .object({
    /** The board's heading, shown at the top. Only "which problem is this board". */
    title: z.string().min(1).max(60),
    /** The units being covered. Passed to @ai-sensei/guardrail's scope check. */
    topic_ids: z.array(topicIdSchema).min(1).max(3),
    steps: z.array(boardStepSchema).min(1).max(boardLessonStepsMaxCount),
  })
  .strict()
  .superRefine((lesson, ctx) => {
    // A skipped or duplicated index is indistinguishable on mobile from "a step that has not arrived yet".
    lesson.steps.forEach((step, position) => {
      if (step.index !== position) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `index は0始まりで1ずつ増やしてください(${position}番目が index=${step.index})`,
          path: ["steps", position, "index"],
        });
      }
    });
  });
export type BoardLesson = z.infer<typeof boardLessonSchema>;

/* -------------------------------------------------------------------------- */
/* data channel (the envelope)                                                */
/* -------------------------------------------------------------------------- */

/**
 * The LiveKit topic. Mobile reads only this topic as the board - a tag that keeps
 * it off the same path as other conversation messages.
 *
 * The path is the Text Streams API (`registerTextStreamHandler` plus this topic),
 * never raw `publishData` - its default is LOSSY and forgetting that drops content
 * (plan §3-5). One envelope = one stream, and the receiver waits for completion
 * with `readAll()`. So the receiver never assembles partial JSON, and the schemas
 * below always meet complete JSON.
 */
export const boardChannelTopic = "board";

/**
 * The envelope version. Raising it makes old clients unable to read, so while old
 * apps remain the agent must send both or choose per client. The number rides in
 * the envelope so that decision stays available later.
 */
export const boardProtocolVersion = 1;

/**
 * The common part of every envelope.
 *
 * - `session_id`: destination check, so a misrouted delivery can be dropped by the
 *   receiver.
 * - `board_id`: one session may cover several problems, so every step belongs to
 *   some board.
 * - `seq`: the running number within the session (0-based, incrementing by 1
 *   across message kinds). A cross-check that does not rely on transport
 *   guarantees. Text Streams is always reliable and handles ordering, dedup and
 *   resend on reconnect (plan §3-5). `seq` exists anyway because the line is not
 *   the only thing that can break - a missed send by the agent, a double send, a
 *   handler dropping a message all look fine to the transport. When `seq` skips,
 *   mobile knows the board has a gap *before* drawing. A step's `index` alone
 *   cannot detect a lost board-switch signal.
 */
const envelopeFields = {
  v: z.literal(boardProtocolVersion),
  session_id: z.string().min(1),
  board_id: z.string().min(1),
  seq: z.number().int().min(0),
};

/**
 * The signal that starts a board (= erases the previous one).
 *
 * "Erase" is a separate signal because the principle is to stack without erasing
 * (§3-2), so the one moment erasure is allowed is "moving to another problem".
 * Making it a step flag (something like `clear: true`) would create a path where
 * the board disappears on the LLM's whim. Switching boards is a delivery-layer
 * decision, not lesson content.
 *
 * It is "moving to another problem", not "the next explanation". One problem is
 * made of several rounds (diagnose -> teach -> have them teach back). Sending this
 * per LLM call erases the board once per exchange. So `board_open` fires once per
 * problem and later explanations stack on the same `board_id`.
 */
export const boardOpenMessageSchema = z
  .object({
    ...envelopeFields,
    type: z.literal("board_open"),
    title: z.string().min(1).max(60),
    topic_ids: z.array(topicIdSchema).min(1).max(3),
  })
  .strict();

/** Stacks one step. This is the body that flows on the data channel. */
export const boardStepMessageSchema = z
  .object({
    ...envelopeFields,
    type: z.literal("board_step"),
    step: boardStepSchema,
  })
  .strict();

/**
 * The signal that closes a board.
 *
 * `step_count` rides along to detect a missing tail. `seq` reveals "something in
 * the middle is missing", but a lost final step that stopped delivery is
 * indistinguishable from "it just has not arrived". Writing the count into the
 * closing declaration gives something to reconcile against.
 */
export const boardCloseMessageSchema = z
  .object({
    ...envelopeFields,
    type: z.literal("board_close"),
    /** The total for one board (not for one explanation). */
    step_count: z.number().int().min(0).max(boardStepsMaxCount),
    /**
     * `interrupted` is when the user broke in and stopped it (the very benefit of
     * §3-2 option A). The board keeps what it has. It is handled differently from
     * an error, so the reason is a separate enum.
     *
     * One interrupted explanation does not reach here. If the same problem
     * continues after the interruption, the board stays open; it closes when the
     * problem itself ends (or fails to).
     */
    reason: z.enum(["completed", "interrupted", "error"]),
  })
  .strict();

/** A message flowing one at a time on the data channel. Only this shape appears on the wire. */
export const boardChannelMessageSchema = z.discriminatedUnion("type", [
  boardOpenMessageSchema,
  boardStepMessageSchema,
  boardCloseMessageSchema,
]);
export type BoardChannelMessage = z.infer<typeof boardChannelMessageSchema>;

/**
 * One session's delivery log.
 *
 * It never appears on the wire: the data channel always carries one message at a
 * time ({@link boardChannelMessageSchema}), and this is a container for fixtures
 * and golden tests. It is still written as a schema so the ordering rules stay
 * checkable rather than living in a comment:
 *
 *   - `seq` starts at 0 and increases by 1 (gap and duplicate detection)
 *   - steps always sit between `board_open` and `board_close`
 *   - `index` starts at 0 per board and increases by 1
 *   - `board_close.step_count` matches the number of steps actually sent
 *
 * Both the agent's delivery implementation and mobile's receiver pass through
 * this sequence.
 */
export const boardChannelLogSchema = z
  .object({
    messages: z.array(boardChannelMessageSchema).min(1),
  })
  .strict()
  .superRefine(({ messages }, ctx) => {
    const issue = (message: string, position: number) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: ["messages", position],
      });

    const sessionId = messages[0]?.session_id;
    let openBoardId: string | null = null;
    let sentSteps = 0;

    messages.forEach((message, position) => {
      if (message.seq !== position) {
        issue(`seq は0始まりで1ずつ増やしてください(seq=${message.seq})`, position);
      }
      if (message.session_id !== sessionId) {
        issue("1つのログに複数のセッションを混ぜないでください", position);
      }

      if (message.type === "board_open") {
        if (openBoardId !== null) {
          issue(`板書 ${openBoardId} が board_close されていません`, position);
        }
        openBoardId = message.board_id;
        sentSteps = 0;
        return;
      }

      if (message.board_id !== openBoardId) {
        issue("board_open されていない板書のメッセージです", position);
        return;
      }

      if (message.type === "board_step") {
        if (message.step.index !== sentSteps) {
          issue(
            `index は板書ごとに0始まりで1ずつ(${sentSteps} を期待して ${message.step.index})`,
            position,
          );
        }
        sentSteps += 1;
        return;
      }

      if (message.step_count !== sentSteps) {
        issue(`step_count が実際に送った手順数(${sentSteps})と違います`, position);
      }
      openBoardId = null;
    });
  });
export type BoardChannelLog = z.infer<typeof boardChannelLogSchema>;
