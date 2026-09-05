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
  type SolvingReport,
  type SpokenProblemMemoryResult,
  asksForProblemReadout,
  classifySolvingReport,
  lessonContinuationInstruction,
  lessonSteps,
  stepAwaitsSolving,
  stepAwaitsStudent,
  studentSilenceMarker,
} from "./senpai.ts";

/**
 * フェーズ1「授業」の**往復**。`board.ts` が寿命の説明に書いた形をここで回す:
 *
 *   1往復目: 教える → 問いかけたところで止まる
 *   生徒が答える
 *   2往復目: 答えを受けて、**同じ板書に**続きを積む
 *   …
 *   最後: 生徒が画面下の「わかった」を押す(それまで積み続ける)
 *
 * 配送層(`BoardDelivery.append()` × n → `close()`)は最初からこの往復を
 * 想定して作られていたが、呼び出し側が1往復で会話へ落としていた。その結果、
 * 質問を1つ挟んだ時点で板書の続きが書けなくなり、解法の残りは音声だけになる —
 * 「もっと先輩主導で、板書と一緒に教え切ってほしい」という
 * ドッグフーディングの報告は、この欠けた配線のことだった。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【往復の終わり方】降りるのは生徒。時間だけが安全弁(ADR 0009)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * **回数の上限は無い。**以前は6周(`defaultMaxLessonPasses`)で降りていたが、
 * 6は生徒の理解と無関係な数字で、そこで切れた生徒は途中で放り出されていた。
 * 押されるまで同じ板書に積む。
 *
 * 降りる条件は2つだけ:
 *
 *   - **`understood` が来た**(画面下の「わかった」)  → 読み上げごと即座に止めて降りる。
 *                                                       復習問題が作られるのはこの道だけ
 *   - **残り時間が締めの枠を切った**(`minContinueSeconds`)
 *                                                     → 新しいパスを始めず、
 *                                                       呼び出し側が締めの一言を言う
 *
 * 授業の中で起きることは変わらない。合図は最後の手順:
 *
 *   - 類題を解く手順(`stepAwaitsSolving`)                  → 15秒判定を使わず、
 *                                                              セッション残り時間まで待つ
 *   - 答えを待つ手順(`stepAwaitsStudent` — 一次は `awaits_student` の申告、
 *     欄が無ければ言い回しの推測)                       → 答えを待って、続きを積む
 *   - 答えを待たず言い切った                            → 続きを積む。**降りない** —
 *     降ろすのは生徒の「わかった」だけになった
 *
 * 言い回しの推測だけだった頃は、見本どおりの「まず何する? 一言でいいよ。」を
 * 渡し忘れと誤読して**1パス目で授業を終えていた**(以降の板書が二度と増えない)。
 * 申告を一次にした理由はそれ(`stepAwaitsStudent` のコメントと #122)。
 *
 * `maxPasses` は残してあるが、**既定は無い**。渡すのは教え返し中の再入
 * (`agent.ts` の `serveBoardRequests`)だけで、あれは「板書して」1回への
 * 応答の長さであって、授業そのものの上限ではない。
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
 * 続きの往復に入ってよい残り時間の下限(秒)。**「締めに残す枠」**(ADR 0009)。
 *
 * 以前は「教え返しに残す枠」だった。教え返しを畳んだので意味を移してあるが、
 * **枠そのものは消さない。**上限回数を外しただけだと、天井が
 * 「20分で突然切れる」に変わる — `waitForEnd` の `timeout` は会話の途中で切るので、
 * 生徒には事故に見える。これを切ったら新しいパスを始めず、先輩から
 * 「今日はここまでにしよっか」を言わせて降りる。**時間切れが事故に見えないように
 * するのは、この一言だけ。**
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

  /**
   * 次の問題へ移る前に、前の問題の答え・類題の本人申告を捨てる。
   * 待機中の `takeUntil` も null で解き、#152 の解答待ちを新しい授業へ持ち越さない。
   */
  clear(): void {
    this.queue.length = 0;
    this.waiter?.settle(null);
  }

  /** 次の発話を待って取り出す。時間切れ・中止は null。 */
  take(timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    return this.wait(signal, timeoutMs);
  }

  /** 次の発話を、外側の中止条件だけで待つ。類題の15秒タイムアウト回避に使う。 */
  takeUntil(signal: AbortSignal): Promise<string | null> {
    return this.wait(signal);
  }

  private wait(signal: AbortSignal | undefined, timeoutMs?: number): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal?.aborted === true) return Promise.resolve(null);

    return new Promise((resolve) => {
      let done = false;
      const settle = (text: string | null) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter !== null && this.waiter.settle === settle) this.waiter = null;
        resolve(text);
      };
      const onAbort = () => settle(null);
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => settle(null), timeoutMs);
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
  /**
   * 生徒が「わかった」を押した。**予定どおりの終わり方で、復習問題が作られる唯一の道。**
   */
  | "understood"
  /** 問いかけずに言い切って終えた。再入(`maxPasses` つき)でだけ起きる。 */
  | "completed"
  /** セッションの終わり(上限時間・離脱)で降りた。 */
  | "interrupted"
  /** 作り直し不能・ストリーム破損・板書の上限。会話だけで続ける。 */
  | "error"
  /**
   * 残り時間が締めの枠(`minContinueSeconds`)を切った。
   * **呼び出し側が締めの一言を言って、その場でセッションを終える。**
   */
  | "time_up"
  /**
   * 往復の上限(再入の `maxPasses`)か、出せない類題を落として降りた。
   * **時間はまだ残っている**ので、セッションは終わらない。
   */
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
  /**
   * systemの末尾に足す、パスごとに変わるひとこと(残り時間)。
   *
   * **`system()` と分ける理由はプロンプトキャッシュ。**4万字級の指示文に残り時間を
   * 織り込むと、パスごとにプレフィックスが変わって一度も読み出しヒットしない
   * (`lesson.ts` の `cache_control` の説明)。
   */
  systemTail?: () => string;
  locale: CurriculumLocale;
  delivery: LessonLoopDelivery;
  /** 手順を1つ配送した直後の読み上げ。`runBoardLesson` の同名の穴。 */
  speak: (step: BoardStep) => Promise<void>;
  /** LLMのチャンク列を包む層(先読み合成)。`runBoardLesson` の同名の穴。 */
  wrapChunks?: (chunks: AsyncIterable<string>) => AsyncIterable<string>;
  /** セッションの終わり。発火したら途中でも即座に降りる(問いかけの途中でも)。 */
  signal: AbortSignal;
  /**
   * 画面下の「わかった」。**押された瞬間に降りる。**
   *
   * `signal`(セッションの終わり)と分けてあるのは、降り方が違うから —
   * こちらは復習問題を作る道で、あちらは作らない道。混ぜると
   * `reason` から出口を判定できなくなる。
   *
   * **読み上げを止めるのは呼び出し側の責務。**このループは
   * LiveKit の `session` を知らないので、`interrupt({ force: true })` は
   * `agent.ts` が同じ合図に乗せて打つ。ここで止められるのは生成と待ち合わせだけ。
   */
  understood?: AbortSignal;
  /** 授業モード中の生徒の発話。`agent.ts` の `onUserTurnCompleted` が積む。 */
  utterances: StudentUtterances;
  /** 消費した発話をtranscriptへ写す口(`collector.add`)。 */
  record: (text: string) => void;
  /**
   * 問題文の音読を頼んだ直後だけ使う、セッション内メモリへの書き込み口。
   * 本文をログへ渡さず、採用結果だけを返す。
   */
  problemReadoutMemory?: {
    isMissing: () => boolean;
    remember: (text: string) => SpokenProblemMemoryResult;
  };
  /** 類題を出してよい授業か。本人申告済みの穴を扱う `review` では false。 */
  practiceProblemEnabled: boolean;
  /** タイムアウトの瞬間に生徒が話しているか(`session.userState`)。 */
  isStudentSpeaking?: () => boolean;
  remainingSeconds: () => number;
  log?: Pick<JobLogger, "info" | "warn">;
  maxPasses?: number;
  answerTimeoutMs?: number;
  minContinueSeconds?: number;
  /**
   * この往復が始まる前に、同じ板書で既に起きていたこと。
   *
   * 教え返しの最中の「板書して」で授業へ**再入**するときに使う(`agent.ts` の
   * `serveBoardRequests`)。ここが空でなければ、最初のパスから継続の指示
   * (`lessonContinuationInstruction`)になる — 素の初回指示で呼ぶと、LLMは
   * 授業を最初から書き直して、出済みの手順を同じ板書へ二重に積んでしまう。
   */
  priorTurns?: readonly LessonTurn[];
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
    systemTail,
    locale,
    delivery,
    speak,
    wrapChunks,
    signal,
    understood,
    utterances,
    record,
    problemReadoutMemory,
    practiceProblemEnabled,
    isStudentSpeaking = () => false,
    remainingSeconds,
    log,
    maxPasses,
    answerTimeoutMs = defaultAnswerTimeoutMs,
    minContinueSeconds = defaultMinContinueSeconds,
    priorTurns = [],
  } = options;

  /**
   * 待ち合わせを解く合図。**セッションの終わりと「わかった」の両方**で解く。
   *
   * 分けたままにすると、問いかけの答えを15秒待っている最中に「わかった」を
   * 押された回が、その15秒を待ち切ってからしか降りない — 押したのに何も
   * 起きない時間ができる。**降りた理由**は下の `exitReason()` が区別する。
   */
  const stopSignal = understood === undefined ? signal : AbortSignal.any([signal, understood]);

  /** 待ち合わせが解けたとき、どちらの合図で降りたか。 */
  const exitReason = (): LessonLoopReason =>
    understood?.aborted === true ? "understood" : "interrupted";

  const turns: LessonTurn[] = [...priorTurns];
  const rejections: BoardStepRejection[] = [];
  let boardId = "";
  let opened = false;
  let stepCount = 0;
  let passes = 0;
  let problemReadoutRequests = priorTurns.filter(
    (turn) => turn.kind === "step" && asksForProblemReadout(turn.step.speech, locale),
  ).length;

  /** 音読依頼の直後の発話だけを問題文として採用する。本文はログに出さない。 */
  const rememberProblemReadout = (step: BoardStep | undefined, text: string): void => {
    if (
      step === undefined ||
      problemReadoutMemory === undefined ||
      !problemReadoutMemory.isMissing() ||
      !asksForProblemReadout(step.speech, locale) ||
      !stepAwaitsStudent(step, locale)
    ) {
      return;
    }

    const remembered = problemReadoutMemory.remember(text);
    if (remembered.accepted) {
      log?.info("problem_readout_captured", { pass: passes, length: remembered.length });
    } else {
      log?.info("problem_readout_rejected", { pass: passes, reason: remembered.reason });
    }
  };
  /** 類題の本人申告。直後の1パスだけに、採点せず分岐する指示として渡す。 */
  let pendingSolvingReport: SolvingReport | undefined;

  const summary = (reason: LessonLoopReason): LessonLoopResult => ({
    board_id: boardId,
    opened,
    step_count: stepCount,
    turns,
    passes,
    reason,
    rejections,
  });

  /** 回数の上限は既定では無い(ADR 0009)。渡されるのは再入のときだけ。 */
  const withinPassBudget = (): boolean => maxPasses === undefined || passes < maxPasses;

  const canContinue = (): boolean =>
    withinPassBudget() && remainingSeconds() >= minContinueSeconds && !delivery.isClosed;

  while (true) {
    passes += 1;
    let skippedSolving = false;
    /** 2回目の読み上げ依頼を配送前に落としたか。観測して警告に出す。 */
    let blockedProblemReadout = false;
    const solvingReportForPass = pendingSolvingReport;

    // このパスの中止条件は「セッションの終わり」か「生徒が話し始めた」。
    // 生徒の発話で止めるのは §3-2 案Aの利点そのもの — ただし従来と違い、
    // 止めた発話は捨てずに次のパスの文脈として同じ板書に続ける。
    const passAbort = new AbortController();
    const stopPass = () => passAbort.abort();
    const detachUtterance = utterances.onPush(stopPass);
    // 「わかった」でも生成を止める。押したのに先輩が喋り続けるのがいちばん悪い。
    stopSignal.addEventListener("abort", stopPass, { once: true });

    let result: BoardLessonResult;
    try {
      result = await runBoardLesson({
        llm,
        system: system(),
        systemTail: systemTail?.(),
        locale,
        delivery,
        speak,
        wrapChunks,
        // 文脈が1つでもあれば継続の指示。初回の定型指示に戻るのは、
        // この板書でまだ何も起きていないときだけ。
        instruction:
          turns.length === 0
            ? undefined
            : lessonContinuationInstruction(turns, locale, solvingReportForPass),
        // 類題を見せてから「時間がないので答えなくてよい」とするのが一番混乱する。
        // 次の1パスと教え返しに120秒を残せないときは、送信前に従来の締めへ縮退する。
        // `review` も同じ口で抑止し、プロンプトがぶれても Issue の `new` 限定を守る。
        stopBefore: (step) => {
          /**
           * **2回目の読み上げ依頼は、板書とTTSへ出る前に落とす。**
           *
           * 継続の指示で「もう一度頼まない」と書いてはいるが、モデルが外したときに
           * 事後のログだけでは遅い —— `runBoardLesson` は手順を配送して `speak` を
           * 呼んでから返るので、観測した時点で**生徒にはもう二度目が届いている**。
           * 「毎回読ませる」を直しに来た変更なので、ここは観測ではなく門にする。
           */
          if (problemReadoutRequests >= 1 && asksForProblemReadout(step.speech, locale)) {
            blockedProblemReadout = true;
            return true;
          }
          if (!stepAwaitsSolving(step)) return false;
          const shouldSkip =
            !practiceProblemEnabled ||
            !withinPassBudget() ||
            remainingSeconds() < minContinueSeconds ||
            delivery.isClosed;
          if (shouldSkip) skippedSolving = true;
          return shouldSkip;
        },
        signal: passAbort.signal,
        log,
      });
    } finally {
      detachUtterance();
      stopSignal.removeEventListener("abort", stopPass);
    }

    for (const step of result.steps) turns.push({ kind: "step", step });
    rejections.push(...result.rejections);
    boardId = result.board_id;
    opened = opened || result.opened;
    stepCount = result.step_count;
    if (result.appended > 0) pendingSolvingReport = undefined;

    // **「わかった」を先に見る。**セッションの終わりと同じ扱いにすると、
    // 復習問題が作られる道と作られない道が `reason` で区別できなくなる。
    if (stopSignal.aborted) return summary(exitReason());

    const lastTurn = turns.at(-1);
    const lastStep = lessonSteps(turns).at(-1);
    const awaitsStudent = lastStep !== undefined && stepAwaitsStudent(lastStep, locale);

    // 第一声と problem_resolved を session_id で突き合わせるための観測口。
    // speech 本文は問題文を含みうるので残さず、定型の依頼だったかだけを見る。
    const readoutSteps = result.steps.filter((step) => asksForProblemReadout(step.speech, locale));
    const problemWasMissing = problemReadoutMemory?.isMissing() ?? false;
    if (passes === 1 && priorTurns.length === 0) {
      log?.info("lesson_opening_observed", {
        problem_present: !problemWasMissing,
        problem_readout_requested: readoutSteps.length > 0,
      });
    }
    for (const readoutStep of readoutSteps) {
      problemReadoutRequests += 1;
      const fields = {
        pass: passes,
        problem_present: !problemWasMissing,
        repeated: problemReadoutRequests > 1,
        awaits_student: stepAwaitsStudent(readoutStep, locale),
      };
      if (fields.problem_present || fields.repeated) {
        // 問題文があるのに頼んだ / 2パス目以降も頼んだ、のどちらもユーザーへ
        // 同じ聞き直しを届けた縮退。Sentry側でも本文なしで気づける warn にする。
        log?.warn("problem_readout_unexpected", fields);
      } else {
        log?.info("problem_readout_requested", fields);
      }
    }

    // 生徒には届いていない(配送前に落とした)が、プロンプトが守られなかった事実は残す。
    if (blockedProblemReadout) {
      log?.warn("problem_readout_blocked", { pass: passes });
    }

    if (skippedSolving) {
      log?.info("lesson_solving_skipped", {
        passes,
        practice_problem_enabled: practiceProblemEnabled,
        remaining_seconds: remainingSeconds(),
      });
      // **時間で落としたのか、そもそも出せない授業だったのかを分ける。**
      // 復習(`practiceProblemEnabled: false`)で類題を落とした回まで `time_up` に
      // すると、まだ10分残っているのに先輩が「今日はここまで」と言って部屋が閉じる。
      return summary(remainingSeconds() < minContinueSeconds ? "time_up" : "budget");
    }

    // 類題を解いている沈黙には通常の15秒タイムアウトを使わない。
    // 待ちの安全弁はセッション残り時間だけで、時間切れの再促しもしない。
    if (lastTurn?.kind === "step" && stepAwaitsSolving(lastTurn.step)) {
      const remainingMs = Math.max(0, Math.floor(remainingSeconds() * 1000));
      if (remainingMs === 0) return summary("interrupted");
      const solvingDeadline = AbortSignal.timeout(remainingMs);
      const solvingSignal = AbortSignal.any([stopSignal, solvingDeadline]);
      const report = await utterances.takeUntil(solvingSignal);

      if (report === null) {
        if (!stopSignal.aborted) {
          log?.info("lesson_solving_deadline", {
            passes,
            remaining_seconds: remainingSeconds(),
          });
        }
        return summary(exitReason());
      }

      record(report);
      turns.push({ kind: "student", text: report });
      pendingSolvingReport = classifySolvingReport(report, locale);
      log?.info("lesson_solving_report", {
        pass: passes,
        report: pendingSolvingReport,
      });
      continue;
    }

    // ここには「『自分の言葉で説明してみて』まで来たら授業は完了」があった。
    // **教え返しは ADR 0009 で畳んだ**ので、先輩の言い方では降りない —
    // 降ろすのは生徒の「わかった」と、残り時間だけ。
    //
    // 板書LLMが言い方を外して教え返しを口にしても、ここは反応しない。
    // 反応させると、**生徒が押していないのに授業が終わる**(いちばん直したかった形が
    // 別の顔で戻ってくる)。プロンプト側でも受け渡しの節は消してある。

    // 問いの内容は機械では判定しない。ただし `awaits_student: true` の授業中の問いは
    // `text` の Q 行を残す規約なので、種類だけを全件記録すれば `none / 全件` の割合を
    // 後から測れる。発話や板書本文は、学習内容をログへ出さないため意図的に含めない。
    //
    // **見るのは `turns` の末尾ではなく、このパスが実際に配送した手順。**
    // 生成が1手順も出せずに終わった回(ストリーム失敗・即割り込み)は `turns` の末尾が
    // 前のパスの問いのままなので、同じ問いを新しいパス番号でもう一度数えてしまい、
    // 測ろうとしている `board_missing` の割合がその二重計上ぶんだけ歪む。
    const deliveredStep = result.steps.at(-1);
    if (deliveredStep?.awaits_student === true) {
      log?.info("lesson_awaiting_question_board", {
        pass: passes,
        board_kind: deliveredStep.board?.kind ?? "none",
        board_missing: deliveredStep.board === null,
      });
    }

    // 安全弁。ここで降りるとき、積み残しの発話は**取り出さない** —
    // 記録も返事も、板書の要約を持った会話モード(呼び出し側)が引き取る。
    if (!canContinue()) {
      const outOfTime = remainingSeconds() < minContinueSeconds;
      log?.info("lesson_loop_budget", {
        passes,
        remaining_seconds: remainingSeconds(),
        board_closed: delivery.isClosed,
        // 回数で降りたのは再入だけ。授業そのものは残り時間でしか降りない。
        pass_budget: maxPasses ?? null,
        out_of_time: outOfTime,
      });
      return summary(outOfTime ? "time_up" : "budget");
    }

    // 説明の途中で生徒が口を開いた。その発話に、同じ板書の続きで応える。
    const interjection = utterances.tryTake();
    if (interjection !== null) {
      record(interjection);
      rememberProblemReadout(lastStep, interjection);
      turns.push({ kind: "student", text: interjection });
      log?.info("lesson_interjection", { pass: passes });
      continue;
    }

    if (result.reason === "error" || result.closed) {
      if (result.closed || result.appended === 0) {
        // 板書の上限で閉じた、または1手順も進まないまま落ちた(作り直し不能・
        // 最初の手順から壊れた出力)。**進めないものを続けても同じ失敗の族に落ちる。**
        // 縮退の言い方は呼び出し側が決める。
        return summary("error");
      }
      // 手順は積めている(途中で切れた出力・詰め込みすぎ・途中の手順の作り直し不能)。
      // 積めた手順は有効で、板書も開いたまま — ここで授業ごと降りると、
      // **1回の失敗が残りの授業を丸ごと道連れにして、板書が途中のまま凍る**。
      // 続きの指示(recap入り)を持って次のパスへ。上限は canContinue が持つ。
      log?.info("lesson_error_continued", { pass: passes, appended: result.appended });
      continue;
    }

    if (result.reason === "interrupted") {
      // 中止は掛かったが、発話は空白だけで捨てられた(咳のSTT誤起こしなど)。
      // 待っても次が来る保証はないので、セッション終了と同じ側に倒す。
      return summary("interrupted");
    }

    if (!awaitsStudent) {
      // 答えを待たずに言い切って終えた。
      //
      // **ここで降りるのは再入のときだけ。**授業そのものは「わかった」まで積むので、
      // 言い切った回は続きを書かせる(`canContinue()` は上で通っている)。
      // 以前はここで教え返しへ渡していたが、渡す先が無くなった。
      if (maxPasses !== undefined) return summary("completed");
      log?.info("lesson_no_handoff_continued", { pass: passes });
      continue;
    }

    // 問いかけで止まっている。答えを待って、同じ板書に続ける。
    let answer = await utterances.take(answerTimeoutMs, stopSignal);
    if (answer === null && !stopSignal.aborted && isStudentSpeaking()) {
      // 締め切りの瞬間、生徒はまだ話している途中。言い終わりを待つ。
      answer = await utterances.take(answerGraceMs, stopSignal);
    }
    if (stopSignal.aborted) return summary(exitReason());

    if (answer === null) {
      // 生徒の発話ではないので record しない(カルテの材料に混ぜない)。
      turns.push({ kind: "student", text: studentSilenceMarker(locale) });
      log?.info("lesson_answer_timeout", { pass: passes });
    } else {
      record(answer);
      rememberProblemReadout(lastStep, answer);
      turns.push({ kind: "student", text: answer });
    }
  }
}
