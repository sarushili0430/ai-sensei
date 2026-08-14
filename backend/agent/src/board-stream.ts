/**
 * Incremental parsing of the board JSON — the delivery layer's entrance.
 *
 * The LLM streams the shape of `boardLessonSchema` from `@ai-sensei/contract`
 * (`{ title, topic_ids, steps: [...] }`). This consumes that string in chunks and
 * emits exactly one step the moment `steps[i]` closes.
 *
 * Never `JSON.parse` the whole thing at the end. That is the rejected option
 * (generate everything, then play), and it discards the reasons streaming was
 * chosen: being interruptible and not keeping the student waiting. The time to
 * the first step becomes the length of the silence.
 *
 * How long that silence is, measured: one step's audio has a median of 2.5s and a
 * maximum of 5.3s (the seven steps in
 * `packages/contract/fixtures/board-lesson.json` at 330 characters per minute for
 * Japanese TTS; the English fixture lands in the same 2.8-4.1s band). Waiting for
 * a whole board multiplies that by the number of steps.
 *
 * Do not use `speech`'s 120-character ceiling (~22s) as one step's length. It is
 * the contract's safety valve, not a typical value, and keeping speech to
 * questions and connective tissue pushes away from it. That mistake was actually
 * made once; the account is in design decision 2 of `board.ts`.
 *
 * Calling `JSON.parse` on one step's completed JSON is correct, though. The
 * requirement is not to wait for everything, not to decode JSON values by hand.
 * So this only detects boundaries — it scans for where each step begins and ends
 * and hands that slice to the standard `JSON.parse`. Escapes, Unicode and number
 * formats are never re-implemented, so no "parser dialect" can disagree with the
 * contract.
 *
 * No dependency was added, and the reason belongs here rather than in a README:
 * every incremental JSON library is built to complete unfinished JSON and return
 * partial objects, which means handing over an unclosed step as though its values
 * were settled. On the board that goes straight onto the wire (sends cannot be
 * undone), so completion is harmful. What is wanted here is only the position of
 * the `}`.
 */

/** Thrown when parsing breaks; the caller closes the board with `error`. */
export class BoardStreamError extends Error {}

/**
 * Character cap for one stream.
 *
 * Twelve steps of `tex` up to 200 and `speech` up to 120 is only a few KB.
 * Greatly exceeding that means either the LLM is emitting the same step forever
 * or something that is not JSON is arriving, and neither improves with waiting.
 * Without a cap it holds an unclosed string and waits with a "not yet" face.
 */
export const boardStreamMaxLength = 64_000;

/**
 * What the parser emits.
 *
 * - `lesson_head`: both `title` and `topic_ids` arrived; material for
 *   `board_open`.
 * - `step`: `steps[i]` closed. The raw, unvalidated value is passed on.
 *
 * Content validation (zod, LaTeX matching) does not happen here. This layer knows
 * nothing about the contract, only where things end.
 */
export type BoardStreamEvent =
  | { type: "lesson_head"; title: unknown; topic_ids: unknown }
  | { type: "step"; raw: unknown };

const isWhitespace = (character: string): boolean =>
  character === " " || character === "\t" || character === "\n" || character === "\r";

/**
 * The streaming JSON parser.
 *
 * State is tracked per character (`inString` / `escaped`) so a chunk splitting
 * inside a string or mid-escape does not break it. `feed()` gives chunk
 * boundaries no special treatment at all — it simply resumes where it left off.
 *
 * How nesting depth is counted (get this wrong and step boundaries shift):
 *
 *   depth 1 = inside the root object `{ ... }`
 *   depth 2 = inside `"steps": [ ... ]`
 *   depth 3 = inside a `steps[i]` object `{ ... }`  <- closing this is one step
 */
export class BoardLessonStreamParser {
  private buffer = "";
  private position = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private stringStart = -1;
  /** Whether the root `{` was found; any preamble or code fence before it is skipped. */
  private started = false;
  /** Whether the root `}` was reached. */
  private closed = false;
  /** The next string at the root level is a key. */
  private expectKey = false;
  /** The root key whose value is currently being read. */
  private key: string | null = null;
  /** Just after reading `:`; the next non-space character starts the value. */
  private awaitingValue = false;
  private valueStart = -1;
  private inSteps = false;
  private stepStart = -1;
  private title: { value: unknown } | null = null;
  private topicIds: { value: unknown } | null = null;
  private headEmitted = false;
  private out: BoardStreamEvent[] = [];

  /** Whether the root JSON closed; needed to tell a truncated board apart. */
  get completed(): boolean {
    return this.closed;
  }

  /**
   * Consumes one chunk and returns only what newly closed in it; an empty array
   * if nothing did. One chunk can close two steps.
   */
  feed(chunk: string): BoardStreamEvent[] {
    if (this.closed) return [];
    this.buffer += chunk;
    if (this.buffer.length > boardStreamMaxLength) {
      throw new BoardStreamError(
        `板書のJSONが長すぎます(${this.buffer.length} > ${boardStreamMaxLength})`,
      );
    }
    this.out = [];
    this.scan();
    return this.out;
  }

  private scan(): void {
    while (this.position < this.buffer.length) {
      const index = this.position;
      const character = this.buffer[index] as string;
      this.position += 1;

      if (this.inString) {
        // Escapes span chunks; a split on a backslash carries into the next
        // `feed()`.
        if (this.escaped) {
          this.escaped = false;
          continue;
        }
        if (character === "\\") {
          this.escaped = true;
          continue;
        }
        if (character === '"') {
          this.inString = false;
          this.onStringEnd(index + 1);
        }
        continue;
      }

      if (!this.started) {
        // Prose preamble and code fences are dropped here (as `extractJson` in
        // karte.ts does).
        if (character !== "{") continue;
        this.started = true;
        this.depth = 1;
        this.expectKey = true;
        continue;
      }

      if (this.awaitingValue && !isWhitespace(character)) {
        this.valueStart = index;
        this.awaitingValue = false;
      }

      // `steps` holds objects only. Silently skipping a stray string or number
      // would let the board complete one step short.
      if (
        this.inSteps &&
        this.depth === 2 &&
        !isWhitespace(character) &&
        character !== "{" &&
        character !== "," &&
        character !== "]"
      ) {
        throw new BoardStreamError(`steps の要素がオブジェクトではありません: ${character}`);
      }

      switch (character) {
        case '"':
          this.inString = true;
          this.stringStart = index;
          break;

        case "{":
          this.depth += 1;
          if (this.inSteps && this.depth === 3 && this.stepStart === -1) this.stepStart = index;
          break;

        case "[":
          this.depth += 1;
          if (this.depth === 2 && this.key === "steps") this.inSteps = true;
          break;

        case "}": {
          if (this.depth === 1) {
            // The root closed; finish any scalar value still open.
            this.finishValue(index);
            this.depth = 0;
            this.closed = true;
            return;
          }
          if (this.inSteps && this.depth === 3 && this.stepStart !== -1) {
            // The heart of it: emit exactly one step the moment it closes.
            this.out.push({
              type: "step",
              raw: this.parseSlice(this.stepStart, index + 1, "手順"),
            });
            this.stepStart = -1;
          }
          this.depth -= 1;
          if (this.depth === 1) this.finishValue(index + 1);
          break;
        }

        case "]":
          if (this.inSteps && this.depth === 2) this.inSteps = false;
          this.depth -= 1;
          if (this.depth === 1) this.finishValue(index + 1);
          break;

        case ",":
          if (this.depth === 1) {
            this.finishValue(index);
            this.expectKey = true;
          }
          break;

        case ":":
          if (this.depth === 1) this.awaitingValue = true;
          break;

        default:
          break;
      }
    }
  }

  /** A string closed at the root level: either a key or a value like `title`. */
  private onStringEnd(endExclusive: number): void {
    if (this.depth !== 1) return;

    if (this.expectKey) {
      const key = this.parseSlice(this.stringStart, endExclusive, "キー");
      if (typeof key !== "string") {
        throw new BoardStreamError("JSONのキーが文字列ではありません");
      }
      this.key = key;
      this.expectKey = false;
      return;
    }

    if (this.key !== null && this.valueStart === this.stringStart) {
      this.finishValue(endExclusive);
    }
  }

  /**
   * One root-level value finished. Only `title` and `topic_ids` are picked up
   * (material for `board_open`); `steps` is never read as a whole array, since
   * steps are emitted as they close.
   */
  private finishValue(endExclusive: number): void {
    const key = this.key;
    const start = this.valueStart;
    this.key = null;
    this.valueStart = -1;
    this.awaitingValue = false;
    if (key === null || start === -1) return;

    if (key === "title") this.title = { value: this.parseSlice(start, endExclusive, "title") };
    else if (key === "topic_ids") {
      this.topicIds = { value: this.parseSlice(start, endExclusive, "topic_ids") };
    }

    // Emitted once, when both have arrived. The LLM decides the order, so either
    // may come first.
    if (!this.headEmitted && this.title !== null && this.topicIds !== null) {
      this.headEmitted = true;
      this.out.push({
        type: "lesson_head",
        title: this.title.value,
        topic_ids: this.topicIds.value,
      });
    }
  }

  /** Only closed slices go to the standard `JSON.parse`; never an unfinished one. */
  private parseSlice(start: number, endExclusive: number, what: string): unknown {
    const source = this.buffer.slice(start, endExclusive);
    try {
      return JSON.parse(source);
    } catch (error) {
      throw new BoardStreamError(
        `${what}のJSONが読めません: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
