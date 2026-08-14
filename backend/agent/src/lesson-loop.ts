import type { BoardStep } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import type { BoardStepRejection } from "./board.ts";
import {
  type BoardLessonDelivery,
  type BoardLessonResult,
  type LessonLlm,
  runBoardLesson,
} from "./lesson.ts";
import type { JobLogger } from "./log.ts";
import {
  type LessonTurn,
  asksForTeachBack,
  handsTurnToStudent,
  lessonContinuationInstruction,
  lessonSteps,
  studentSilenceMarker,
} from "./senpai.ts";

/**
 * フェーズ1「授業」の**往復**。`board.ts` が寿命の説明に書いた形をここで回す:
 *
 *   1往復目: 教える → 問いかけたところで止まる
 *   生徒が答える
 *   2往復目: 答えを受けて、**同じ板書に**続きを積む
 *   …
 *   最後: 「じゃあ今の、自分の言葉で説明してみて」で教え返しへ渡す
 *
 * 配送層(`BoardDelivery.append()` × n → `close()`)は最初からこの往復を
 * 想定して作られていたが、呼び出し側が1往復で会話へ落としていた。その結果、
 * 質問を1つ挟んだ時点で板書の続きが書けなくなり、解法の残りは音声だけになる —
 * 「もっと先輩主導で、板書と一緒に教え切ってほしい」という
 * ドッグフーディングの報告は、この欠けた配線のことだった。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【往復の終わり方】言い方で決める。回数と時間は安全弁
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 授業がどこまで続くかは板書LLMが決める(教え切ったかどうかは中身の話なので、
 * コードには判定できない)。合図は最後の手順の言い方:
 *
 *   - 「自分の言葉で説明してみて」(`asksForTeachBack`) → 授業は完了。教え返しへ
 *   - それ以外の問いかけ(`handsTurnToStudent`)        → 答えを待って、続きを積む
 *   - 問いかけず言い切った                              → 渡し忘れ。呼び出し側の
 *     `teachBackFallback` が定型句で教え返しへ戻す(1往復だった頃と同じ保険)
 *
 * 言い方だけに任せると、生成が1回ぶれただけで永遠に教え続ける。だから
 * **回数(`maxPasses`)と残り時間(`minContinueSeconds`)の安全弁**を重ねる。
 * 安全弁で降りるときに問いかけが出たままでも、立て直しの一言は言わない —
 * 番はもう生徒にあり、答えは教え返しの会話LLM(板書の要約を持っている)が受ける。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【生徒の発話は2種類とも同じ口から入る】
 * ─────────────────────────────────────────────────────────────────────────
 *
 * - **答え**: 問いかけで止まって待っている間の発話。次のパスの文脈になる。
 * - **割り込み**: 説明の途中の発話。パスを中止し(§3-2 案Aの利点)、
 *   その発話に**同じ板書の続きで**応える。会話モードへ落とさないのが従来との違い —
 *   落とすと、そこから先の板書が二度と書けない。
 *
 * どちらも {@link StudentUtterances} に積まれ、ループが消費した時点で
 * `record`(transcript)へ写す。**答えが無かったとき(タイムアウト)は記録しない** —
 * それは生徒の発話ではないので、カルテの材料に混ぜない。授業の列にだけ
 * `studentSilenceMarker` を残し、次のパスに「軽く自分で言って先へ進む」を選ばせる。
 */

/** 授業の往復の上限。1パス最大12手順 × ここまでで、板書上限(40手順)に届く。 */
export const defaultMaxLessonPasses = 6;

/**
 * 問いかけへの答えを待つ時間。
 *
 * 短すぎると考えている生徒に被せ、長すぎると黙った生徒の前で授業が止まったままになる。
 * ターン検出の `maxDelay`(4秒)は**話し始めてから**の間なので、ここはそれより
 * 一桁長い「そもそも話し始めない」ための時間。切れたら先輩が軽く答えを言って先へ進む
 * (問い詰めない — 約束4)。
 */
export const defaultAnswerTimeoutMs = 15_000;

/**
 * タイムアウトの瞬間に生徒が話し始めていたときの猶予。
 *
 * VADの発話開始からSTTの確定までは数秒かかる。ここで待たずに締め切ると、
 * **答えている途中の生徒に「答えは出なかった」扱いで被せる** —
 * 「聞いてくれない」報告の再生産になるので、言い終わりまで待つ。
 */
export const answerGraceMs = 10_000;

/**
 * 続きの往復に入ってよい残り時間の下限(秒)。
 *
 * これを切ったら新しい問いかけを始めず、いまの状態のまま教え返しへ渡す。
 * 教え返しが丸ごと消えると、カルテの材料(ユーザーの説明)が残らない —
 * このアプリの本体は教え返しなので、授業の続きより優先する。
 */
export const defaultMinContinueSeconds = 120;

/**
 * 授業モード中の生徒の発話置き場。
 *
 * `agent.ts` の `onUserTurnCompleted` が積み(会話LLMには `StopResponse` で
 * 返事を作らせない)、ループが答え・割り込みとして取り出す。
 * **ここは取り出しの順番と待ち合わせだけを持つ。**transcriptへの記録は
 * 消費した側の責務(取り出さずに終わった発話は、会話モードが引き取って応える)。
 */
export class StudentUtterances {
  private readonly queue: string[] = [];
  private waiter: { settle: (text: string | null) => void } | null = null;
  private readonly listeners = new Set<() => void>();

  /** STTが確定した発話を積む。空白だけの発話は積まない(合図も出さない)。 */
  push(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const waiter = this.waiter;
    if (waiter !== null) {
      waiter.settle(trimmed);
    } else {
      this.queue.push(trimmed);
    }
    // 合図は積んだ**あと**。パス中止の口(`onPush`)が先に走ると、
    // 中止側が取り出そうとした時点でまだ何も無い、という順序になる。
    for (const listener of [...this.listeners]) listener();
  }

  /** 積まれた発話を1つ、待たずに取り出す。無ければ null。 */
  tryTake(): string | null {
    return this.queue.shift() ?? null;
  }

  /** 次の発話を待って取り出す。時間切れ・中止は null。 */
  take(timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal?.aborted === true) return Promise.resolve(null);

    return new Promise((resolve) => {
      let done = false;
      const settle = (text: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter !== null && this.waiter.settle === settle) this.waiter = null;
        resolve(text);
      };
      const onAbort = () => settle(null);
      const timer = setTimeout(() => settle(null), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = { settle };
    });
  }

  /** 発話が積まれた瞬間の合図。説明の途中のパス中止に使う。戻り値で解除する。 */
  onPush(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get pending(): boolean {
    return this.queue.length > 0;
  }
}

/** 板書1枚のうち、往復が使う口。`BoardDelivery` がそのまま満たす。 */
export type LessonLoopDelivery = BoardLessonDelivery & { readonly isClosed: boolean };

export type LessonLoopReason =
  /** 「自分の言葉で説明してみて」まで言えた。予定どおりの終わり方。 */
  | "handed_over"
  /** 問いかけずに言い切って終えた(渡し忘れ)。呼び出し側が定型句で締める。 */
  | "completed"
  /** セッションの終わり(上限時間・離脱)で降りた。 */
  | "interrupted"
  /** 作り直し不能・ストリーム破損・板書の上限。会話だけで続ける。 */
  | "error"
  /** 回数か残り時間の安全弁。問いかけが出たままなら、答えは会話モードが受ける。 */
  | "budget";

export type LessonLoopResult = {
  board_id: string;
  opened: boolean;
  /** 板書1枚の合計手順数(往復をまたいだ通し)。 */
  step_count: number;
  /** 起きたことの列: 配送済みの手順と、合間の生徒の発話。 */
  turns: LessonTurn[];
  passes: number;
  reason: LessonLoopReason;
  rejections: BoardStepRejection[];
};

export type RunLessonLoopOptions = {
  llm: LessonLlm;
  /**
   * パスごとに呼ばれる。残り時間を織り込んだシステムプロンプトを毎回作り直す
   * (固定文字列を1回だけ組むと、締めの判断が授業開始時の残り時間のまま止まる)。
   */
  system: () => string;
  locale: CurriculumLocale;
  delivery: LessonLoopDelivery;
  /** 手順を1つ配送した直後の読み上げ。`runBoardLesson` の同名の穴。 */
  speak: (step: BoardStep) => Promise<void>;
  /** セッションの終わり。発火したら途中でも即座に降りる(問いかけの途中でも)。 */
  signal: AbortSignal;
  /** 授業モード中の生徒の発話。`agent.ts` の `onUserTurnCompleted` が積む。 */
  utterances: StudentUtterances;
  /** 消費した発話をtranscriptへ写す口(`collector.add`)。 */
  record: (text: string) => void;
  /** タイムアウトの瞬間に生徒が話しているか(`session.userState`)。 */
  isStudentSpeaking?: () => boolean;
  remainingSeconds: () => number;
  log?: Pick<JobLogger, "info" | "warn">;
  maxPasses?: number;
  answerTimeoutMs?: number;
  minContinueSeconds?: number;
};

/**
 * 授業の往復を回す。戻ったとき、板書は開いたまま(締めるのはセッションの終わり)。
 *
 * 例外は投げない設計に乗る — `runBoardLesson` はストリームの失敗を
 * `reason: "error"` に畳んで返すので、ここで拾うべき例外は残っていない。
 */
export async function runLessonLoop(options: RunLessonLoopOptions): Promise<LessonLoopResult> {
  const {
    llm,
    system,
    locale,
    delivery,
    speak,
    signal,
    utterances,
    record,
    isStudentSpeaking = () => false,
    remainingSeconds,
    log,
    maxPasses = defaultMaxLessonPasses,
    answerTimeoutMs = defaultAnswerTimeoutMs,
    minContinueSeconds = defaultMinContinueSeconds,
  } = options;

  const turns: LessonTurn[] = [];
  const rejections: BoardStepRejection[] = [];
  let boardId = "";
  let opened = false;
  let stepCount = 0;
  let passes = 0;

  const summary = (reason: LessonLoopReason): LessonLoopResult => ({
    board_id: boardId,
    opened,
    step_count: stepCount,
    turns,
    passes,
    reason,
    rejections,
  });

  const canContinue = (): boolean =>
    passes < maxPasses && remainingSeconds() >= minContinueSeconds && !delivery.isClosed;

  while (true) {
    passes += 1;

    // このパスの中止条件は「セッションの終わり」か「生徒が話し始めた」。
    // 生徒の発話で止めるのは §3-2 案Aの利点そのもの — ただし従来と違い、
    // 止めた発話は捨てずに次のパスの文脈として同じ板書に続ける。
    const passAbort = new AbortController();
    const stopPass = () => passAbort.abort();
    const detachUtterance = utterances.onPush(stopPass);
    signal.addEventListener("abort", stopPass, { once: true });

    let result: BoardLessonResult;
    try {
      result = await runBoardLesson({
        llm,
        system: system(),
        locale,
        delivery,
        speak,
        instruction: passes === 1 ? undefined : lessonContinuationInstruction(turns, locale),
        signal: passAbort.signal,
        log,
      });
    } finally {
      detachUtterance();
      signal.removeEventListener("abort", stopPass);
    }

    for (const step of result.steps) turns.push({ kind: "step", step });
    rejections.push(...result.rejections);
    boardId = result.board_id;
    opened = opened || result.opened;
    stepCount = result.step_count;

    if (signal.aborted) return summary("interrupted");

    const lastSpeech = lessonSteps(turns).at(-1)?.speech ?? "";

    // 「自分の言葉で説明してみて」まで来たら授業は完了。教え返しへ渡す。
    if (asksForTeachBack(lastSpeech, locale)) return summary("handed_over");

    // 安全弁。ここで降りるとき、積み残しの発話は**取り出さない** —
    // 記録も返事も、板書の要約を持った会話モード(呼び出し側)が引き取る。
    if (!canContinue()) {
      log?.info("lesson_loop_budget", {
        passes,
        remaining_seconds: remainingSeconds(),
        board_closed: delivery.isClosed,
      });
      return summary("budget");
    }

    // 説明の途中で生徒が口を開いた。その発話に、同じ板書の続きで応える。
    const interjection = utterances.tryTake();
    if (interjection !== null) {
      record(interjection);
      turns.push({ kind: "student", text: interjection });
      log?.info("lesson_interjection", { pass: passes });
      continue;
    }

    if (result.reason === "error" || result.closed) {
      // 作り直し不能・途中で切れた出力・板書の上限。同じ入力で続けても
      // 同じ失敗の族に落ちる。縮退の言い方は呼び出し側が決める。
      return summary("error");
    }

    if (result.reason === "interrupted") {
      // 中止は掛かったが、発話は空白だけで捨てられた(咳のSTT誤起こしなど)。
      // 待っても次が来る保証はないので、セッション終了と同じ側に倒す。
      return summary("interrupted");
    }

    if (!handsTurnToStudent(lastSpeech, locale)) {
      // 問いかけずに言い切って終えた(番の渡し忘れ)。呼び出し側の
      // `teachBackFallback` が定型句で教え返しへ戻す。
      return summary("completed");
    }

    // 問いかけで止まっている。答えを待って、同じ板書に続ける。
    let answer = await utterances.take(answerTimeoutMs, signal);
    if (answer === null && !signal.aborted && isStudentSpeaking()) {
      // 締め切りの瞬間、生徒はまだ話している途中。言い終わりを待つ。
      answer = await utterances.take(answerGraceMs, signal);
    }
    if (signal.aborted) return summary("interrupted");

    if (answer === null) {
      // 生徒の発話ではないので record しない(カルテの材料に混ぜない)。
      turns.push({ kind: "student", text: studentSilenceMarker(locale) });
      log?.info("lesson_answer_timeout", { pass: passes });
    } else {
      record(answer);
      turns.push({ kind: "student", text: answer });
    }
  }
}
