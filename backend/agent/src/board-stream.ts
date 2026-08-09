/**
 * 板書JSONの逐次パース(配送層の入口)。
 *
 * LLMは `@ai-sensei/contract` の `boardLessonSchema` の形
 * (`{ title, topic_ids, steps: [...] }`)をストリーミングで吐く。ここはその文字列を
 * チャンクのまま食べて、**`steps[i]` が閉じた瞬間に1手順だけ** 取り出す。
 *
 * **最後にまとめて `JSON.parse` してはいけない。** それは計画書 §3-2 の案B
 * (全部生成してから再生)そのもので、「割り込める・待たされない」という
 * 採用理由が丸ごと消える。**最初の1手順を送るまでの時間が、そのまま沈黙の長さになる。**
 *
 * その沈黙が何秒に相当するかは、実測でこう:
 * 1手順の音声は**中央値2.5秒・最長5.3秒**(`packages/contract/fixtures/board-lesson.json` の
 * 7手順を日本語TTS 330字/分で換算。英語のfixtureも2.8〜4.1秒で同じ帯)。
 * 板書1枚ぶんを待てば、**手順の数だけ倍になった長さ**が頭に付く。
 *
 * **`speech` の上限120字(≒22秒)を1手順の長さとして使わないこと。**
 * あれは契約の安全弁であって典型値ではなく、§3-1(音声は問いかけと接続だけ)は
 * `speech` を上限から**遠ざける**方向に働く。この取り違えは一度実際にやったので、
 * 経緯は `board.ts` の設計判断の2に残してある。
 *
 * ただし **「1手順ぶんの完成したJSON」に対して `JSON.parse` を呼ぶのは正しい**。
 * §3-2 が要求しているのは「全部揃うのを待たない」ことであって、
 * 自前でJSONの値をデコードすることではない。だからここがやるのは
 * **境界の検出だけ** — どこからどこまでが1手順かを走査で決め、その断片を
 * 標準の `JSON.parse` に渡す。エスケープ・Unicode・数値表現の解釈を自作しないので、
 * 「パーサの方言」で契約と食い違う経路が生まれない。
 *
 * 依存は足していない(理由は `README` ではなくここに書く):
 * 逐次JSONのライブラリはどれも「未完のJSONを補完して部分オブジェクトを返す」設計で、
 * **閉じていない手順を「値が揃った手順」として渡してくる**。板書では
 * それがそのままワイヤーに出る(送信は取り消せない)ので、補完は害になる。
 * ここで欲しいのは補完ではなく **`}` の位置** だけ。
 */

/** 走査が壊れたときの例外。呼び出し側は板書を `error` で締める。 */
export class BoardStreamError extends Error {}

/**
 * 1本のストリームで受け取る文字数の上限。
 *
 * 手順12件 × (`tex` 200字 + `speech` 120字)でも数KBにしかならない。
 * それを大きく超えるのは、LLMが同じ手順を延々と吐き続けているか、
 * JSONではないものが流れてきているかのどちらかで、**どちらも待っても直らない**。
 * 上限がないと、閉じない文字列を掴んだまま「まだ来ていない」の顔で待ち続ける。
 */
export const boardStreamMaxLength = 64_000;

/**
 * 走査が外に出すもの。
 *
 * - `lesson_head`: `title` と `topic_ids` が両方揃った。`board_open` の材料。
 * - `step`: `steps[i]` が閉じた。**検証前の生の値**を渡す。
 *
 * 中身の検証(zod・LaTeX照合)はここではやらない。ここは契約を知らない層で、
 * 「どこで切れているか」だけを知っている。
 */
export type BoardStreamEvent =
  | { type: "lesson_head"; title: unknown; topic_ids: unknown }
  | { type: "step"; raw: unknown };

const isWhitespace = (character: string): boolean =>
  character === " " || character === "\t" || character === "\n" || character === "\r";

/**
 * ストリーミングJSONの走査器。
 *
 * 文字列の中・エスケープの途中でチャンクが切れても壊れないよう、状態は
 * **文字単位** で持つ(`inString` / `escaped`)。`feed()` はチャンク境界を
 * まったく特別扱いしない — 前回の続きから走査を再開するだけ。
 *
 * ネストの深さの数え方(この対応が崩れると手順の境界を取り違える):
 *
 *   depth 1 = ルートオブジェクト `{ ... }` の中
 *   depth 2 = `"steps": [ ... ]` の中
 *   depth 3 = `steps[i]` のオブジェクト `{ ... }` の中  ← ここが閉じたら1手順
 */
export class BoardLessonStreamParser {
  private buffer = "";
  private position = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private stringStart = -1;
  /** ルートの `{` を見つけたか。見つけるまでの前置き・```json フェンスは読み飛ばす。 */
  private started = false;
  /** ルートの `}` まで読み切ったか。 */
  private closed = false;
  /** 次にルート直下で現れる文字列はキー。 */
  private expectKey = false;
  /** いま値を読んでいるルートのキー。 */
  private key: string | null = null;
  /** `:` を読んだ直後。次の非空白文字が値の先頭。 */
  private awaitingValue = false;
  private valueStart = -1;
  private inSteps = false;
  private stepStart = -1;
  private title: { value: unknown } | null = null;
  private topicIds: { value: unknown } | null = null;
  private headEmitted = false;
  private out: BoardStreamEvent[] = [];

  /** ルートのJSONを閉じるところまで読めたか。**途中で切れた板書と区別する**ために要る。 */
  get completed(): boolean {
    return this.closed;
  }

  /**
   * チャンクを1つ食べて、そのチャンクで**新しく閉じた**ものだけを返す。
   * 何も閉じなければ空配列。1チャンクで2手順が閉じることもある。
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
        // エスケープはチャンクをまたぐ。`\` で切れても次の `feed()` に持ち越す。
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
        // 前置きの日本語や ```json のフェンスはここで落ちる(karte.ts の extractJson と同じ扱い)。
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

      // steps の要素はオブジェクトだけ。文字列や数値が混ざっていたら、
      // 黙って読み飛ばすと**手順が1つ減ったまま板書が完成してしまう**。
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
            // ルートが閉じた。手前にスカラー値が残っていれば締める。
            this.finishValue(index);
            this.depth = 0;
            this.closed = true;
            return;
          }
          if (this.inSteps && this.depth === 3 && this.stepStart !== -1) {
            // **ここが本体。** 手順が閉じた瞬間に1つだけ取り出す。
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

  /** ルート直下で文字列が閉じた。キーか、`title` のような文字列の値か。 */
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
   * ルート直下の値が1つ読み終わった。
   * 拾うのは `title` と `topic_ids` だけ(`board_open` の材料)。
   * `steps` は配列全体を値としては読まない — 手順は閉じた端から出している。
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

    // 両方揃った時点で1回だけ。順序はLLM任せなので、どちらが先でもよい形にしてある。
    if (!this.headEmitted && this.title !== null && this.topicIds !== null) {
      this.headEmitted = true;
      this.out.push({
        type: "lesson_head",
        title: this.title.value,
        topic_ids: this.topicIds.value,
      });
    }
  }

  /** **閉じた断片だけ**を標準の `JSON.parse` に渡す。未完のものは絶対に渡さない。 */
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
