import {
  type BoardChannelMessage,
  type BoardStep,
  boardChannelMessageSchema,
  boardChannelTopic,
  boardProtocolVersion,
  boardStepSchema,
  boardStepsMaxCount,
} from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import {
  type LatexRejectionReason,
  checkBoardLatex,
  latexRejectionGuidanceByLocale,
} from "@ai-sensei/guardrail";
import { BoardLessonStreamParser, BoardStreamError } from "./board-stream.ts";
import type { JobLogger } from "./log.ts";

/**
 * 板書の配送層。LLMのストリーミング出力を、手順が閉じた端から
 * LiveKit の Text Streams(topic `board`)へ1手順ずつ流す。
 *
 * ここが持つのは **配管だけ**。何を板書するか(先輩の口調・教え方・式の組み立て)は
 * プロンプトの責務で、このファイルは一切知らない。逆に、宛先(`session_id`)・
 * 板書の識別(`board_id`)・順序(`seq` / `index`)・締め方(`reason`)は
 * **全部こちらの責務**で、LLMの出力には漏らさない(`contract/src/board.ts` の分担)。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【設計判断】送りながら検証する以上、落ちた手順の手前は取り消せない
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 8手順の板書で、0〜4は送信済み、5手順目の `tex` が `checkBoardLatex` に弾かれた。
 * 送信は取り消せない(板書は積み上げで、消えるのは `board_open` のときだけ)。
 *
 * **採るのは (b) — 落ちた手順だけ直させて、続きを送る。** 上限回数を超えたら
 * `board_close(reason: "error")` で締め、**そこまでの板書は残す**。
 *
 * 理由:
 *
 * 1. **(a) 全部バッファしてから送る、は却下。**§3-2 が案Aを採ったのは
 *    「割り込める・待たされない」ためで、全バッファは案Bそのもの。
 *    覆すだけの根拠は見つからなかった。むしろ逆で、**全バッファは
 *    この問題自体を解かない** — 板書1枚を丸ごと捨てて作り直すことになり、
 *    「1手順の作り直し」より待ち時間が長い。
 *
 * 2. **(b) の待ちは、1手順ぶんの音声と同じ桁。隠れるかどうかは、隠れ蓑を
 *    どこに求めるかで決まる。**
 *
 *    最初ここに「1手順は `speech` 120字 = 約20〜25秒のTTSだから、その裏に隠れる」と
 *    書いた。**これは誤り。120字は契約の上限であって典型値ではない。**
 *    §3-1(音声は問いかけと接続だけ)は `speech` を上限に張り付かせる原則ではなく、
 *    **上限から遠ざける**原則で、実際そうなっている。
 *    実測(`packages/contract/fixtures/board-lesson.json` の7手順):
 *
 *      中央値 14字 ≒ **2.5秒**、最長 29字 ≒ **5.3秒**(日本語TTS 330字/分)
 *      英語のfixture(`board-lesson.en.json`)も 39〜57字 ≒ **2.8〜4.1秒**で同じ帯
 *
 *    **1手順の音声は2〜5秒で、再生成の往復と同じ桁。**上限を根拠にすると
 *    「1手順あたり20秒の余裕がある」という前提が次にここを触る人に残るので、
 *    誤りごと残しておく。
 *
 *    本当の余裕は、**生成がTTSより速いことで積み上がるリード**のほう。
 *    1手順ぶんのJSON(数十トークン)を作る時間は、その手順を読み上げる時間より短い。
 *    差は手順ごとにたまるので、手順5で再生成が要るときの待ちは、
 *    手順0〜4で積み上がったリードから引かれる。
 *    **予測: 授業が進むほどリードは厚くなり、序盤ほど再生成は目立つ。**
 *    最初の手順で落ちたときはリードがゼロで、待ちがそのまま沈黙になる
 *    (§3-2 が「最初の手順までの無音」を事前生成音声で埋めると決めた、あの穴と同じ場所)。
 *
 *    **ただしリードが積み上がる場所は、呼び出し側の {@link DeliverBoardOptions.onStep}
 *    の作り方で変わる。**TTSへ渡して即座に返すなら、リードは配送そのものに乗る
 *    (板書が音声を追い越して積まれる)。読み上げ終わりまで待つなら、
 *    §3-2 の「同期の粒度は手順」は守られるが、**リードは生成側にしか残らず、
 *    再生成の往復は音声の空白としてそのまま出る**。後者を採るつもりなら、
 *    再生成の待ちは隠れないものとして扱うこと — {@link defaultMaxRepairAttempts} を
 *    1回にしてあるのはそのため。
 *
 * 3. **既に送った手順は、直後の手順が落ちても無効にならない。**板書は
 *    1手順=1行の積み上げ(§3-2)で、手順4は手順5の下書きではない。
 *    落ちるのは「この式は `flutter_math_fork` が描けない」という**描画の理由**であって、
 *    手順4の内容が間違っていたわけではない。取り消す理由がない。
 *
 * 4. **(c) 板書ごと作り直す、は割に合わない。**ただし (c) の欠点は
 *    「`board_close(error)` を送ると画面がリセットされる」ではない —
 *    契約上、板書が消えるのは **`board_open` が来たときだけ**で、
 *    `board_close` は何も消さない。リセットを起こすのは、そのあとに送る
 *    `board_open` のほう。つまり (c) の本当のコストは
 *    **「生徒が読んでいる途中の板書が、生徒には理由の分からないタイミングで白紙に戻る」**。
 *    §3-2 の「前の行は消さない」を、ユーザーには観測できない内部事情で破ることになる。
 *
 * 5. だから**行き止まりの締め方も (c) ではなく「閉じるだけ」にする。**
 *    再生成が上限に達したら `board_close(reason: "error")` を送って終わる。
 *    板書は途中まで残り、`interrupted` と同じ扱いになる。
 *    先輩は会話(音声)で続けられるし、次の問題に移るときの `board_open` で
 *    初めて画面が変わる。**「壊れたら止まる。ただし今あるものは消さない」**が、
 *    この層の失敗のしかた。
 *
 * 再生成そのもの(LLMへの投げ直し)は {@link StepRepair} として外に出してある。
 * 落ちた理由に対応する `latexRejectionGuidanceByLocale` の指示文を添えて渡すので、
 * 呼び出し側は「その文をプロンプトに足してもう一度吐かせる」だけでよい。
 * ここに書かないのは、**この層が実鍵なしでテストできる**ことを保つため。
 */

/** 封筒1つを送る先。LiveKit を差し替えられるように、ここで薄く切っている。 */
export type BoardSink = {
  send(message: BoardChannelMessage): Promise<void>;
};

/** `sendText` を持つもの(= `room.localParticipant`)。LiveKit の型に依存しないための構造型。 */
export type TextStreamPublisher = {
  sendText(text: string, options?: { topic?: string }): Promise<unknown>;
};

/**
 * LiveKit の Text Streams へ送る sink。
 *
 * **封筒1つ = 1ストリーム**(§3-5)。`sendText` は1回の呼び出しで
 * ストリームを開いて書いて閉じるので、受信側の `readAll()` がそのまま
 * 「封筒1つが揃った」になる。生の `publishData` は使わない —
 * 既定が LOSSY で、書き忘れると板書が黙って欠ける。
 */
export function createTextStreamBoardSink(publisher: TextStreamPublisher): BoardSink {
  return {
    async send(message) {
      await publisher.sendText(JSON.stringify(message), { topic: boardChannelTopic });
    },
  };
}

/** 手順が検証に落ちた理由。再生成の指示文まで込みで渡す。 */
export type BoardStepRejection = {
  /** 落ちた手順が積まれるはずだった位置(= そのとき送ろうとしていた `index`)。 */
  index: number;
  /** `latex` は描画できない式、`schema` は契約違反(長さ・形)。 */
  kind: "latex" | "schema";
  reason: LatexRejectionReason | "schema";
  /** 何が引っかかったか(ログ用)。 */
  detail: string;
  /** **会話の言語で書かれた再生成の指示。**そのままプロンプトに足せる。 */
  guidance: string;
  /** 落ちた手順の生の値。直させるときの材料。 */
  raw: unknown;
};

/**
 * 落ちた手順を直させる。直せなければ `null` を返す(そこで板書は `error` で締まる)。
 * 実装はLLM呼び出しになるが、**この層はそれを知らない**(テストではただの関数)。
 */
export type StepRepair = (rejection: BoardStepRejection) => Promise<unknown>;

/** 契約に合わなかったときの指示。LaTeXの理由別の文面は guardrail 側にある。 */
const schemaGuidanceByLocale: Record<CurriculumLocale, string> = {
  ja: "手順の形が契約に合っていません。speech は120字以内の話し言葉(数式を入れない)、board は latex / text / plot / triangle / circle のどれか、または null にすること。",
  en: "The step does not match the contract. Keep speech under 120 characters of plain spoken language (no formulas), and make board one of latex / text / plot / triangle / circle, or null.",
};

export type StepVerdict =
  | { ok: true; step: BoardStep }
  | { ok: false; rejection: BoardStepRejection };

/**
 * 手順1つを検証する。**ワイヤーに出る前の最後の関門**。
 *
 * `index` は **LLMの申告を採らず、実際に送る位置で上書きする**。
 * `index` は「板書の何行目に積むか」という配送の事実で、モバイルはこれを
 * `seq` と並ぶ欠落検知に使う(contract README の不変条件の表)。
 * LLMの数え間違いをそのまま流すと、**受信側は正しく届いた板書を「抜けている」と判定する** —
 * 直せる嘘を、検知能力のある場所に置いてしまうことになる。
 * ずれていた事実はログに出す(呼び出し側の {@link BoardChannel} が拾う)。
 */
export function validateStep(raw: unknown, index: number, locale: CurriculumLocale): StepVerdict {
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
        guidance: `${schemaGuidanceByLocale[locale]} (${detail})`,
        raw,
      },
    };
  }

  const board = parsed.data.board;
  if (board !== null && board.kind === "latex") {
    // 三段構えの②(§3-6)。移植版が描けないコマンドは、届いた時点で
    // その行だけ空白か例外になる。授業の途中で1行消えるのは、遅いより悪い。
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
  }

  return { ok: true, step: parsed.data };
}

export type BoardChannelOptions = {
  sessionId: string;
  locale: CurriculumLocale;
  sink: BoardSink;
  /**
   * `board_id` の発行。テストから固定値を入れられるようにしてある。
   *
   * 既定はUUID。契約は `z.string().min(1)` しか要求していない(形は契約ではない)。
   * fixtureが `brd_01J8Z9...` というULID風なのは、`backend/api` の `newId()` で
   * 作られたIDの見本だから — あれは別パッケージで、agent からは import できない。
   * 時系列に並ぶIDが欲しくなったら、ここに関数を渡せばよい。
   */
  newBoardId?: () => string;
  log?: Pick<JobLogger, "info" | "warn">;
};

export type DeliverBoardOptions = {
  /** LLMの出力。チャンクの切れ目はどこでもよい(文字列の中・エスケープの中でも壊れない)。 */
  chunks: AsyncIterable<string>;
  /**
   * ユーザーの割り込み。**abort したら板書は途中で締める**(§3-2 案Aの利点そのもの)。
   * チャンク待ちの最中でも効くよう、`next()` と競走させている —
   * ポーリングだけだと、LLMが黙り込んだときに締めそこねる。
   */
  signal?: AbortSignal;
  /**
   * 手順を1つ送り終えた直後に呼ぶ。**板書 → 音声の順**(§3-2)を守るための穴で、
   * 呼び出し側はここで `step.speech` をTTSへ渡す。
   *
   * **返すまで次の手順は送らない。**ここに何を待たせるかが、そのまま
   * 同期の粒度になる:
   *
   *   - TTSへ渡して即座に返す → 板書が音声を追い越して積まれる。
   *     再生成の待ちはこのリードに吸収されるが、§3-2 の「同期の粒度は手順」は緩む。
   *   - 読み上げ終わりまで待つ → 手順単位の同期は保たれる。ただし
   *     **再生成の往復は音声の空白としてそのまま出る**(上の設計判断の2)。
   *
   * どちらを採るかはまだ決めていない。W1のドッグフーディングで、
   * 板書が音声より何行先に出ていると読みにくいかを見てから決める値。
   */
  onStep?: (step: BoardStep) => void | Promise<void>;
  repair?: StepRepair;
  /** 1手順あたりの作り直し回数の上限。0にすると再生成しない。 */
  maxRepairAttempts?: number;
};

export type BoardDeliveryResult = {
  board_id: string;
  /** `board_open` を送ったか。**送っていなければ `board_close` も送っていない**。 */
  opened: boolean;
  /** 実際にワイヤーへ出した手順数。`board_close.step_count` と同じ値。 */
  step_count: number;
  reason: "completed" | "interrupted" | "error";
  /** 検証に落ちた手順(直って送れたものも含む)。プロンプト調整の材料。 */
  rejections: BoardStepRejection[];
};

/** 割り込みの合図。`iterator.next()` と競走させるための番人。 */
const aborted = Symbol("aborted");

/**
 * 1セッションぶんの板書チャネル。
 *
 * **`seq` はここが持つ**。契約上 `seq` は「セッション内の通し番号(0始まり・
 * 種別をまたいで1ずつ)」なので、板書を跨いで連番になる。板書ごとに
 * リセットすると、2枚目の `board_open` で受信側が「巻き戻った」と見る。
 */
export class BoardChannel {
  // コンストラクタ引数への修飾子は使わない(`node --experimental-strip-types`・ADR 0002)。
  private readonly sessionId: string;
  private readonly locale: CurriculumLocale;
  private readonly sink: BoardSink;
  private readonly newBoardId: () => string;
  private readonly log: Pick<JobLogger, "info" | "warn"> | undefined;
  private seq = 0;

  constructor(options: BoardChannelOptions) {
    this.sessionId = options.sessionId;
    this.locale = options.locale;
    this.sink = options.sink;
    this.newBoardId = options.newBoardId ?? (() => `brd_${crypto.randomUUID()}`);
    this.log = options.log;
  }

  /** 次に送る封筒の `seq`(テストと検算用)。 */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * 板書1枚を配送する。ストリームを食べながら、手順が閉じた端から送る。
   *
   * 送るのは常に `board_open` → `board_step` × n → `board_close` の順。
   * **`board_open` を送れなかったときは、何も送らない** — 開いていない板書の
   * 手順は受信側が捨てるので(contract README「未開封の `board_id` は捨てる」)、
   * 送るだけ無駄で、`seq` を無駄に進めるぶん害がある。
   */
  async deliver(options: DeliverBoardOptions): Promise<BoardDeliveryResult> {
    const {
      chunks,
      signal,
      onStep,
      repair,
      maxRepairAttempts = defaultMaxRepairAttempts,
    } = options;

    const boardId = this.newBoardId();
    const parser = new BoardLessonStreamParser();
    const rejections: BoardStepRejection[] = [];
    /** ヘッダ(title / topic_ids)より先に閉じた手順の待避所。 */
    const pending: unknown[] = [];

    let opened = false;
    let sent = 0;
    let reason: BoardDeliveryResult["reason"] = "completed";

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
            // ここで初めて `board_open` を送れる。以降のヘッダは無視(1枚に1つ)。
            if (opened) continue;
            await this.send({
              v: boardProtocolVersion,
              session_id: this.sessionId,
              board_id: boardId,
              seq: this.seq,
              type: "board_open",
              // 型は封筒スキーマが見る。LLMが変な値を入れたらここで落ちて、
              // 板書は1枚も開かない(壊れた板書を開くよりよい)。
              title: event.title as string,
              topic_ids: event.topic_ids as string[],
            });
            opened = true;
            this.log?.info("board_opened", { board_id: boardId, title: event.title });
            continue;
          }
          pending.push(event.raw);
        }

        if (!opened) continue;

        while (pending.length > 0) {
          if (signal?.aborted === true) {
            reason = "interrupted";
            break consume;
          }

          // 12手順を超えたら止める。ここを素通りさせると `index` が契約の上限を
          // 超え、封筒スキーマで落ちる。**「1行ずつだが40行」で答案を流し込む抜け道**
          // (contract の `boardStepsMaxCount`)は、送る前に閉じる。
          if (sent >= boardStepsMaxCount) {
            this.log?.warn("board_steps_overflow", { board_id: boardId, step_count: sent });
            reason = "error";
            break consume;
          }

          const raw = pending.shift();
          const verdict = await this.settleStep({
            raw,
            index: sent,
            repair,
            maxRepairAttempts,
            rejections,
          });

          if (!verdict.ok) {
            // 直らなかった。**そこまでの板書は残したまま**締める(上のコメントの5)。
            this.log?.warn("board_step_rejected", {
              board_id: boardId,
              index: verdict.rejection.index,
              reason: verdict.rejection.reason,
              detail: verdict.rejection.detail,
            });
            reason = "error";
            break consume;
          }

          await this.send({
            v: boardProtocolVersion,
            session_id: this.sessionId,
            board_id: boardId,
            seq: this.seq,
            type: "board_step",
            step: verdict.step,
          });
          sent += 1;

          // 板書を出してから喋る(§3-2)。ここで待つのは意図的で、
          // 音声が板書を追い越すと「ここ、見て」が空の盤面を指すことになる。
          await onStep?.(verdict.step);
        }
      }

      // ルートの `}` まで読めていない = 途中で切れた板書。送った手順は有効だが、
      // 「全部送った」とは言えないので `completed` にはしない。
      if (reason === "completed" && !parser.completed) {
        this.log?.warn("board_stream_truncated", { board_id: boardId, step_count: sent });
        reason = "error";
      }

      // 最後まで読めたのに `title` / `topic_ids` が無かった = 契約違反の板書。
      // 1件も送っていないので受信側には何も起きないが、**成功として返してはいけない** —
      // 呼び出し側が「板書は出た」と思って音声だけ進めてしまう。
      if (reason === "completed" && !opened) {
        this.log?.warn("board_head_missing", { board_id: boardId });
        reason = "error";
      }
    } catch (error) {
      // 走査の破綻(`BoardStreamError`)・封筒の契約違反・送信の失敗。
      // どれも「待っても直らない」ので、締めて返す。
      reason = "error";
      this.log?.warn("board_delivery_failed", {
        board_id: boardId,
        step_count: sent,
        stream_error: error instanceof BoardStreamError,
        message: error instanceof Error ? error.message : String(error),
      });
      releaseIterator(iterator);
    }

    if (opened) {
      // `step_count` は**実際に送った数**。末尾の欠落はこれでしか検知できない。
      await this.send({
        v: boardProtocolVersion,
        session_id: this.sessionId,
        board_id: boardId,
        seq: this.seq,
        type: "board_close",
        step_count: sent,
        reason,
      }).catch((error) => {
        this.log?.warn("board_close_failed", {
          board_id: boardId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (reason === "interrupted") releaseIterator(iterator);

    return { board_id: boardId, opened, step_count: sent, reason, rejections };
  }

  /**
   * 手順1つを、必要なら直させながら確定させる。
   * **落ちた手順はここから外に出ない** — 呼び出し側は `ok` のものしか送らない。
   */
  private async settleStep(input: {
    raw: unknown;
    index: number;
    repair: StepRepair | undefined;
    maxRepairAttempts: number;
    rejections: BoardStepRejection[];
  }): Promise<StepVerdict> {
    const { raw, index, repair, maxRepairAttempts, rejections } = input;
    let candidate = raw;

    for (let attempt = 0; ; attempt += 1) {
      const verdict = validateStep(candidate, index, this.locale);
      if (verdict.ok) {
        this.warnIfIndexMoved(candidate, index);
        return verdict;
      }

      rejections.push(verdict.rejection);
      if (repair === undefined || attempt >= maxRepairAttempts) return verdict;

      try {
        const repaired = await repair(verdict.rejection);
        if (repaired === null || repaired === undefined) return verdict;
        candidate = repaired;
      } catch {
        // 直させる側が落ちたら、それ以上は粘らない(会話は音声で続けられる)。
        return verdict;
      }
    }
  }

  /** LLMの申告した `index` を上書きした事実を残す(プロンプト調整の材料)。 */
  private warnIfIndexMoved(raw: unknown, index: number): void {
    if (typeof raw !== "object" || raw === null) return;
    const declared = (raw as { index?: unknown }).index;
    if (typeof declared === "number" && declared !== index) {
      this.log?.warn("board_step_index_overridden", { declared, index });
    }
  }

  /**
   * 封筒を1つ送る。
   *
   * **送る直前に封筒スキーマで自分を検算する。**配送層のバグ(`seq` の付け間違い・
   * 板書IDの取り違え)は、トランスポートからは正常に見えるので、
   * ここで落とさないと誰も気づかない。
   *
   * `seq` を進めるのは **送れたあと**。失敗した封筒でも番号を消費すると、
   * 受信側からは「1つ欠けた板書」に見えて、次の手順まで巻き添えにする。
   */
  private async send(message: BoardChannelMessage): Promise<void> {
    const validated = boardChannelMessageSchema.parse(message);
    await this.sink.send(validated);
    this.seq += 1;
  }
}

/**
 * 作り直しの既定回数。**1回**。
 *
 * はじめ2回にしていたが、1手順の音声が**2〜5秒**(上の実測)と分かった時点で
 * 割に合わなくなった。訂正後の数字から導くとこうなる:
 *
 *   - 再生成1回(数秒)は、体感で**手順1つぶんの間**にあたる。息継ぎに聞こえる範囲。
 *   - 2回だと手順1つを丸ごと超える沈黙になる。この長さは、このアプリでは既に
 *     一度バグとして扱われている領域(`closingGraceMs = 2500` は「切れて聞こえない」ための
 *     **最小の**余白で、2.5秒が黙って許される長さではないことの裏返し)。
 *   - そして**2回目に渡す材料は1回目と同じ**。`latexRejectionGuidanceByLocale` は
 *     理由ごとに固定の文面で、行き先まで書いてある(「`text` の板書として送れ」)。
 *     1回目で直らなかったのは、その指示が効かない書き方をしているということで、
 *     同じ指示をもう一度渡しても同じ失敗の族に落ちる。**新しい情報のない再試行に、
 *     手順1つぶんの沈黙を払う理由がない。**
 *
 * 呼び出し側は `maxRepairAttempts` で上書きできる。指示文が枝分かれして
 * 「2回目は別の言い方をする」形になったら、そのときは2回に戻す価値が出る。
 */
export const defaultMaxRepairAttempts = 1;

/**
 * 次のチャンクか、割り込みか、早く来たほうを返す。
 *
 * `for await` のポーリングにしないのは、**LLMが黙り込んだときに割り込みを取りこぼす**から。
 * 割り込みは「次のチャンクが来たら気づく」では遅い — 生徒はもう喋っている。
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

  // 割り込みが勝つと、この next() は誰も待たないまま残る。
  // あとで落ちると unhandled rejection でプロセスごと落ちるので、先に手当てする。
  const next = iterator.next();
  next.catch(() => undefined);

  try {
    return await Promise.race([next, interrupted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 上流(LLMのストリーム)を離す。
 *
 * **待たない。**割り込みで抜けるとき、上流は `await` の途中で止まっていることがあり、
 * その状態の async generator に `return()` を投げても**その await が解けるまで返ってこない**
 * (LLMが黙り込んだままなら永久に返らない)。ここで待つと、割り込みの目的である
 * `board_close` が送れなくなる — 生徒はもう喋っているのに板書が締まらない。
 * 後片付けは best effort に留める。
 */
function releaseIterator(iterator: AsyncIterator<string>): void {
  iterator.return?.().catch(() => undefined);
}
