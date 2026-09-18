import type { BoardChannelMessage, TranscriptMessage } from "@ai-sensei/contract";
import { BoardChannel, type BoardSink } from "../board.ts";
import { isClosingUtterance } from "../closing.ts";
import type { SessionContext } from "../context.ts";
import { type LlmClient, buildKarte, createAnthropicClient, emptyKarte } from "../karte.ts";
import {
  type LessonLoopDelivery,
  type LessonLoopResult,
  StudentUtterances,
  runLessonLoop,
} from "../lesson-loop.ts";
import type { LessonLlm } from "../lesson.ts";
import {
  type LessonTurn,
  asksForTeachBack,
  lessonSteps,
  senpaiConversationPrompt,
  stepAwaitsStudent,
  teachBackFallback,
} from "../senpai.ts";
import { TranscriptCollector, renderTranscript } from "../transcript.ts";
import type { EvalEnv } from "./env.ts";
import { boardSystemPrompt, transportFailure } from "./run-board.ts";
import { type EvalScenario, scenarioKey } from "./scenario.ts";
import { scoreTrial } from "./score.ts";
import { type EvalStudent, type StudentPhase, asSpokenLine } from "./student.ts";
import { type TrialRecord, promptSha256, saveTrial, trialSchemaVersion } from "./trial.ts";

/**
 * L2 — 授業の**往復**と教え返しとカルテを、人手なしで1本通す。
 *
 * L1(`run-board.ts`)が測るのは板書1パス。ここが足すのは、そのあとに続く
 * このアプリの本体側:
 *
 *   1. 問いかけで止まった授業に**生徒が答え**、同じ板書に続きが積まれるか
 *   2. 「じゃあ今の、自分の言葉で説明してみて」まで行くか(`loop_reason`)
 *   3. 教え返しの会話が**採点も催促もせず**、締めの言い方で終わるか
 *   4. その会話からカルテ(言えたこと / 穴)が出るか
 *
 * 配線は本番と同じ部品でだけ組む(`senpaiBoardLessonPrompt` → `runLessonLoop` →
 * `senpaiConversationPrompt` → `buildKarte`)。違うのは終端4つ:
 *
 *   - sink      … LiveKit の Text Streams の代わりに封筒を配列へ溜める
 *   - speak     … TTSの代わりに no-op。**ここで生徒を動かす**(下の `speak` の説明)
 *   - 生徒      … マイクとSTTの代わりに `EvalStudent`(`student.ts`)
 *   - 残り時間  … 実時計の代わりに決定的な模擬クロック(下の {@link loopClock})
 *
 * L1と同じく**作り直し(StepRepair / HeadRepair)は効かせない**(`withoutRepair`)。
 */

/**
 * 模擬クロック。**実時計を使わない。**
 *
 * 残り時間は板書プロンプト(締めに入る判断)と会話プロンプト(「今日はここまでに
 * しよっか」)の両方に効く変数で、実時計で測ると**同じプロンプトでも試行ごとに
 * 値が変わる** = `prompt_sha256` が毎回動いて before/after が成立しない。
 *
 * 目盛りは実時間の写しではなく、**1試行の中で締めの分岐を必ず通す**ための値。
 * `perSenpaiTurn` を1パスと同じ桁にしてあるのはそのためで、これが小さいと
 * 教え返しが上限往復で切れるだけになり、`teach_back_closed` が
 * 「締められなかった」しか返さない指標になる。
 */
export const loopClock = {
  /** 有料枠の上限(`max_seconds: 900`)の頭から始める。 */
  startSeconds: 900,
  /** 板書1パス。 */
  perPass: 90,
  /** 生徒の1発話(授業の答えも教え返しの説明も同じ重さ)。 */
  perStudentTurn: 20,
  /** 教え返しの先輩の1発話。 */
  perSenpaiTurn: 90,
} as const;

/**
 * 教え返しの往復の上限。
 *
 * 1往復 = 生徒の説明 + 先輩の応え。ここまで来て締めの言い方が出なければ
 * 打ち切る(`teach_back_closed: false` がその試行の成績)。
 */
export const defaultTeachBackExchanges = 6;

/** 教え返しの1発話の上限トークン。会話プロンプトの「1発話は2文まで」に合わせる。 */
export const teachBackMaxTokens = 400;

/**
 * 教え返しの1発話の上限(文字)。
 *
 * 生徒(`studentUtteranceMaxLength`)より広く取る。先輩の発話はジャッジ(Stage B)が
 * 読む一次資料なので、**約束を破った長い発話ほど切ってはいけない**。
 */
export const teachBackLineMaxLength = 600;

/**
 * 答え待ちの上限(**実時間**)。
 *
 * ここだけは実時計で待つ — `runLessonLoop` のタイムアウトそのものを通したいから。
 * 短くできるのは、生徒の返事を**確定させてから積む**駆動にしてあるので
 * (下の `speak`)、この時間を待つのは「無言の生徒」のときだけになるため。
 * 本番の既定は15秒(`defaultAnswerTimeoutMs`)。
 */
export const defaultLoopAnswerTimeoutMs = 1_500;

/** L2の `prompt_sha256` / `system_prompt` の札。**1パス目のsystem**を使う。 */
export function loopSystemPrompt(scenario: EvalScenario): string {
  return boardSystemPrompt(scenario, loopClock.startSeconds);
}

/**
 * 教え返しの先輩を回すモデル。
 *
 * **`env.ts` に会話の欄が無い**(Stage Aは板書・ジャッジ・生徒・カルテの4本)。
 * 値は `config.ts` の `LLM_MODEL_CONVERSATION` の既定と同じにしてあり、
 * 本番と同条件で測れる。環境変数で振りたくなったら env.ts に欄を足すこと
 * (ここに `process.env` を読む口を作ると、鍵の読み込みが2箇所に分かれる)。
 */
export const defaultConversationModel = "claude-haiku-4-5-20251001";

/** 生徒シミュレータのクライアント。`karte.ts` の素のfetchクライアント(SDKは入れない)。 */
export function createStudentLlm(env: EvalEnv, model: string = env.studentModel): LlmClient {
  return createAnthropicClient({
    apiKey: env.apiKey,
    model,
    ...(env.baseUrl === undefined ? {} : { baseUrl: env.baseUrl }),
  });
}

/** 教え返しの先輩のクライアント。 */
export function createConversationLlm(
  env: EvalEnv,
  model: string = defaultConversationModel,
): LlmClient {
  return createStudentLlm(env, model);
}

/** カルテのクライアント。本番(`LLM_MODEL_KARTE`)と同じ既定。 */
export function createKarteLlm(env: EvalEnv, model: string = env.karteModel): LlmClient {
  return createStudentLlm(env, model);
}

export type TeachBackMessage = { role: "senpai" | "student"; text: string };

export type RunLoopTrialOptions = {
  scenario: EvalScenario;
  /** 1始まり。ファイル名の `t<N>` になる。 */
  trial: number;
  /** 板書LLM(`createBoardLlm`)か、テストのstub。 */
  llm: LessonLlm;
  /** 生徒シミュレータ。`meta.persona` はこの札から取る。 */
  student: EvalStudent;
  /** 教え返しの先輩(`createConversationLlm`)。 */
  conversationLlm: LlmClient;
  /** カルテ(`createKarteLlm`)。省略時は教え返しと同じクライアント。 */
  karteLlm?: LlmClient;
  /** メタに残すモデル名(板書LLM)。 */
  model: string;
  runDir: string;
  maxPasses?: number;
  answerTimeoutMs?: number;
  minContinueSeconds?: number;
  teachBackExchanges?: number;
  /** セッションの終わり。省略すると発火しない(評価に離脱は無い)。 */
  signal?: AbortSignal;
  /** 時刻の注入。テストを決定的にするためだけの穴。 */
  now?: () => number;
};

/**
 * 1試行ぶん走らせて保存する。**例外を投げない**(L1の `runBoardTrial` と同じ契約)。
 *
 * 途中で落ちた試行も一次資料で、そこまでの封筒とプロンプト本文が
 * 「何が壊れたか」を読む材料になる。投げて上へ返すと、直列で回している run が
 * 1本の失敗で止まり、払ったぶんの記録が残らない。
 */
export async function runLoopTrial(options: RunLoopTrialOptions): Promise<TrialRecord> {
  const {
    scenario,
    trial,
    llm,
    student,
    conversationLlm,
    karteLlm = conversationLlm,
    model,
    runDir,
    maxPasses,
    answerTimeoutMs = defaultLoopAnswerTimeoutMs,
    minContinueSeconds,
    teachBackExchanges = defaultTeachBackExchanges,
    signal = new AbortController().signal,
    now = Date.now,
  } = options;

  const context = scenario.context;
  const locale = scenario.locale;

  const envelopes: BoardChannelMessage[] = [];
  const sink: BoardSink = {
    async send(message) {
      envelopes.push(message);
    },
  };

  // 配送層は上流の例外を飲む(`BoardDelivery.append` は `reason: "error"` で
  // 静かに降りる)。理由が残るのは `board_append_failed` の1行だけなので拾う。
  // **ログの受け皿は `BoardChannel` に渡す**(`BoardDelivery` はそこから貰う)。
  const warnings: { event: string; fields: Record<string, unknown> }[] = [];
  const log = {
    info: () => undefined,
    warn: (event: string, fields: Record<string, unknown> = {}) => {
      warnings.push({ event, fields });
    },
  };

  const key = scenarioKey(scenario);
  const channel = new BoardChannel({
    sessionId: `${context.session_id}_t${trial}`,
    locale,
    sink,
    allowedTopicIds: context.allowed_topic_ids,
    // **board_id を決定的にする**(試行のJSONをdiffしたときに封筒の全行が
    // 差分にならないように)。L1と同じ綴り。
    newBoardId: () => `brd_eval_${key}_t${trial}`,
    log,
  });
  const board = channel.startBoard();

  const startedAt = now();
  let firstStepAt: number | undefined;

  /** 残り時間。パス・発話ごとに決定的に減る(実時計は見ない)。 */
  let remaining = loopClock.startSeconds;
  const remainingSeconds = () => Math.max(0, remaining);

  const utterances = new StudentUtterances();
  // 消費された発話をtranscriptへ写す口。本番と同じ `TranscriptCollector`
  // (`normalizeMathSpeech` を通すのはここ)。時刻は使い道が無い
  // (`formatTranscript` は `at_ms` を出さない)ので、実時計を持ち込まない。
  const collector = new TranscriptCollector(new Date(startedAt), context);
  const recordUtterance = (text: string) => {
    collector.add({ role: "user", text, at: new Date(startedAt) });
  };

  /**
   * 生徒に見せる「ここまで起きたこと」。
   *
   * `runLessonLoop` は自分の `turns` を途中で見せないので、配送された手順
   * (`speak`)と自分が積んだ発話から**同じ列を作る**。無言の記録
   * (`studentSilenceMarker`)だけは入らないが、それは生徒自身の沈黙で、
   * 生徒に読ませる文脈ではない。
   */
  const seen: LessonTurn[] = [];

  /** 生徒役の失敗。**授業は殺さない**が、試行は分母から外す札を立てる。 */
  let studentFailure: string | undefined;

  const ask = async (phase: StudentPhase): Promise<string | null> => {
    try {
      return await student.answer(seen, phase);
    } catch (error) {
      // 生徒が返せなかっただけで授業を落とすと、そこまでの板書も捨てることになる。
      // 無言として降りて、理由は `error` に残す(ハーネス側の事故)。
      studentFailure ??= `生徒シミュレータが失敗しました: ${messageOf(error)}`;
      return null;
    }
  };

  let result: LessonLoopResult | undefined;
  let thrown: string | undefined;
  let firstSystem: string | undefined;

  try {
    result = await runLessonLoop({
      llm,
      // パスごとに組み直す(本番と同じ)。残り時間だけが動く。
      system: () => {
        const text = boardSystemPrompt(scenario, remainingSeconds());
        firstSystem ??= text;
        remaining -= loopClock.perPass;
        return text;
      },
      locale,
      delivery: withoutRepair(board),
      utterances,
      record: recordUtterance,
      remainingSeconds,
      signal,
      log,
      answerTimeoutMs,
      ...(maxPasses === undefined ? {} : { maxPasses }),
      ...(minContinueSeconds === undefined ? {} : { minContinueSeconds }),
      /**
       * 読み上げは無いが、**ここが生徒を動かす唯一の穴**になる。
       *
       * `board.ts` は「封筒を送る → `onStep`(= ここ)を待つ → `stopAfter` で
       * 番の受け渡しを見る」の順に進む。だから問いかけの手順でここに来た時点は
       * **そのパスが止まる直前**で、生徒の返事を待つのに一番安全な場所になる:
       *
       *   - `await` して返事を確定させてから積むので、**遅い生徒が
       *     答え待ちのタイムアウトに負けない**(`answerTimeoutMs` を短くできる理由)
       *   - 積んだ発話は `StudentUtterances.onPush` の合図でこのパスを中止させるが、
       *     このあと `stopAfter` が同じ手順で降りるので**何も失われない**
       *   - 返事が `null`(無言)ならそもそも積まない。あとは `runLessonLoop` の
       *     タイムアウトが `studentSilenceMarker` を残す
       */
      speak: async (step) => {
        firstStepAt ??= now();
        seen.push({ kind: "step", step });
        // **教え返しへの受け渡しは、ここで受けない。**渡しの手順はたいてい
        // `awaits_student: true` も立てているので、素通しすると生徒を1回余分に
        // 呼び、その答えは `runLessonLoop` に取り出されないまま捨てられる
        // (授業の列にも transcript にも入らない)。番はもう会話フェーズにある。
        if (asksForTeachBack(step.speech, locale)) return;
        if (!stepAwaitsStudent(step, locale)) return;

        const said = await ask("lesson");
        if (said === null) return;
        seen.push({ kind: "student", text: said });
        remaining -= loopClock.perStudentTurn;
        utterances.push(said);
      },
    });
  } catch (error) {
    thrown = messageOf(error);
  }

  const teachBack =
    result === undefined || !handsToTeachBack(result)
      ? undefined
      : await runTeachBack({
          llm: conversationLlm,
          context,
          lesson: result.turns,
          seen,
          collector,
          startedAt,
          ask,
          exchanges: teachBackExchanges,
          remainingSeconds,
          spend: (seconds) => {
            remaining -= seconds;
          },
        });

  const karte =
    teachBack === undefined
      ? undefined
      : await buildTrialKarte({ context, collector, llm: karteLlm });

  const system = firstSystem ?? loopSystemPrompt(scenario);
  const failure = thrown ?? transportFailure(warnings) ?? studentFailure;

  const record: TrialRecord = {
    meta: {
      schema_version: trialSchemaVersion,
      scenario_id: scenario.id,
      locale,
      stage: "loop",
      trial,
      model,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: Math.max(0, now() - startedAt),
      prompt_sha256: promptSha256(system),
      ...(firstStepAt === undefined
        ? {}
        : { time_to_first_step_ms: Math.max(0, firstStepAt - startedAt) }),
      persona: student.persona,
    },
    system_prompt: system,
    turns: result?.turns ?? [],
    envelopes,
    rejections: result?.rejections ?? [],
    ...(result === undefined
      ? {}
      : {
          loop: {
            reason: result.reason,
            passes: result.passes,
            step_count: result.step_count,
            opened: result.opened,
          },
        }),
    ...(teachBack === undefined ? {} : { teach_back: teachBack }),
    ...(karte === undefined ? {} : { karte }),
    ...(failure === undefined ? {} : { error: failure }),
  };

  const scored: TrialRecord = { ...record, metrics: scoreTrial(record) };
  saveTrial(runDir, scored);
  return scored;
}

/**
 * 教え返しへ渡る終わり方か。
 *
 *   - `handed_over` … 「自分の言葉で説明してみて」まで行った(予定どおり)
 *   - `completed`   … 問いかけずに言い切った(渡し忘れ)。本番と同じく
 *                     `teachBackFallback` の定型句で教え返しへ戻す
 *
 * `budget` / `interrupted` / `error` で降りた回は渡さない。本番はそこでも会話が
 * 続くが、あちらは**まだ部屋が開いている**からで、こちらは授業が届かなかった回。
 * 教え返しを足すと、板書ゼロの試行にカルテが付いて「成立した授業」に見える。
 */
function handsToTeachBack(result: LessonLoopResult): boolean {
  return result.reason === "handed_over" || result.reason === "completed";
}

type RunTeachBackOptions = {
  llm: LlmClient;
  context: SessionContext;
  /** 授業で起きたこと。会話systemの `lesson_recap` になる。 */
  lesson: readonly LessonTurn[];
  /** 生徒に見せる列。教え返しの発話もここへ積む。 */
  seen: LessonTurn[];
  collector: TranscriptCollector;
  startedAt: number;
  ask: (phase: StudentPhase) => Promise<string | null>;
  exchanges: number;
  remainingSeconds: () => number;
  spend: (seconds: number) => void;
};

/**
 * 教え返しの会話。**生徒が先に喋る。**
 *
 * 本番も同じ順で、授業が「自分の言葉で説明してみて」で終わった時点で番は生徒に
 * あり、agentは黙って待つ(`agent.ts` の `teachWithBoard` は `handed_over` の回に
 * 何も言わない)。ここで先輩から先に喋らせると、渡したばかりの番を取り返す
 * 一言が毎回入り、**約束1「先に答えを埋めない」の測定が崩れる**。
 *
 * 渡し忘れ(`completed`)の回だけは、本番と同じ `teachBackFallback` が先に入る。
 *
 * 会話は `LlmClient.complete()`(1往復)で回す。本番のLiveKitのパイプラインは
 * 多ターンの chat context を持つが、ハーネスにあるのは1往復の口だけなので、
 * **ここまでの会話をuserメッセージに畳んで渡す**(systemは本番と同じ正本で、
 * 畳むのは「何が起きたか」だけ — `lessonContinuationInstruction` と同じ形)。
 */
async function runTeachBack(
  options: RunTeachBackOptions,
): Promise<{ messages: TeachBackMessage[]; closed_by_pattern: boolean }> {
  const { llm, context, lesson, seen, collector, startedAt, ask, exchanges, spend } = options;
  const locale = context.locale;
  const messages: TeachBackMessage[] = [];
  let closed = false;

  const saySenpai = (text: string) => {
    messages.push({ role: "senpai", text });
    collector.add({ role: "assistant", text, at: new Date(startedAt) });
    // 先輩の会話発話は板書ではないが、生徒に見せる列に持てる形は手順しかない。
    // `renderLessonRecap` は `board: null` の手順を「発話だけ」として書き下すので、
    // 生徒からは授業の続きと同じに読める。
    seen.push({
      kind: "step",
      step: { index: lessonSteps(seen).length, speech: text, board: null },
    });
  };

  // 番を渡し忘れた授業だけ、定型句で教え返しへ戻す。渡してあるときは `null` が返る
  // ので、同じ問いを二度重ねない(判定は本番と同じ `teachBackFallback`)。
  const fallback = teachBackFallback(context, lessonSteps(lesson));
  if (fallback !== null) saySenpai(fallback);

  for (let exchange = 0; exchange < exchanges; exchange += 1) {
    const said = await ask("teach_back");
    // 無言。教え返しの会話に積むものが無いので、ここで畳む(本番なら部屋が
    // 上限時間まで空回りするが、評価に空回りを測る意味は無い)。
    if (said === null) break;
    messages.push({ role: "student", text: said });
    collector.add({ role: "user", text: said, at: new Date(startedAt) });
    seen.push({ kind: "student", text: said });
    spend(loopClock.perStudentTurn);

    let raw: string;
    try {
      raw = await llm.complete({
        system: senpaiConversationPrompt({
          context,
          // **1発話ごとに組み直す。**本番は教え返しへ渡った時点で instructions を
          // 1度差し替えるだけだが、それだと残り時間が凍り、締めの分岐
          // (「今日はここまでにしよっか」)が1試行の中で一度も通らない。
          remainingSeconds: options.remainingSeconds(),
          lesson,
        }),
        user: teachBackInstruction(messages, locale),
        maxTokens: teachBackMaxTokens,
      });
    } catch {
      // 会話が続かなかった。ここまでの往復は有効なので、畳んで先へ進む
      // (理由はレコードの `error` ではなく `teach_back` の短さに出る)。
      break;
    }

    const reply = asSpokenLine(raw, teachBackLineMaxLength);
    if (reply === null) break;
    saySenpai(reply);
    spend(loopClock.perSenpaiTurn);

    // 締めの言い方(`closing.ts`)。本番はこれで部屋を `completed` として閉じる。
    if (isClosingUtterance(reply)) {
      closed = true;
      break;
    }
  }

  return { messages, closed_by_pattern: closed };
}

/**
 * 教え返しのuserメッセージ。**ロール名は `formatTranscript` の語彙にそろえる。**
 *
 * 「先輩:」「ユーザー:」を自分で書くと、プロンプト側の綴りが変わったときに
 * ここだけ古くなり、モデルが自分の発話と生徒の発話を取り違える。
 */
function teachBackInstruction(messages: readonly TeachBackMessage[], locale: "ja" | "en"): string {
  const dialogue = renderTranscript(
    messages.map(
      (message): TranscriptMessage => ({
        role: message.role === "senpai" ? "assistant" : "user",
        text: message.text,
        at_ms: 0,
      }),
    ),
    locale,
  );

  return locale === "en"
    ? [
        'This is the teach-back so far. "Senpai:" lines are yours; "Student:" lines are the user.',
        "",
        dialogue,
        "",
        "Reply as the senpai. One turn only.",
        "- Write only the line you say (no name, no quotation marks, no commentary).",
        "- Two sentences at most. No markdown, no bullets.",
      ].join("\n")
    : [
        "教え返しのやりとりです。「先輩:」の行があなたの発話、「ユーザー:」の行が相手の発話です。",
        "",
        dialogue,
        "",
        "先輩として、次の1発話だけを返してください。",
        "- セリフだけを書きます(名前・かぎ括弧・説明は付けない)。",
        "- 2文まで。記号で飾らない。",
      ].join("\n");
}

/**
 * カルテ。**本番と同じ経路**(`buildKarte` が `applyGuardrails` まで通す)。
 *
 * `withUncertaintyHole` は足さない。あれは「わからない」と言ったのに穴ゼロの
 * カルテを出さないための**コード側の保険**で、評価で足すと `karte_holes` が
 * 「プロンプトが書けた穴」ではなく「保険が埋めた穴」を数えることになる。
 *
 * 一度も喋っていない会話でカルテを作らないのも本番と同じ(空のカルテは失敗ではない)。
 */
async function buildTrialKarte(input: {
  context: SessionContext;
  collector: TranscriptCollector;
  llm: LlmClient;
}): Promise<unknown> {
  if (!input.collector.hasUserSpeech) return emptyKarte();
  try {
    return await buildKarte({
      context: input.context,
      transcript: input.collector.all,
      llm: input.llm,
    });
  } catch (error) {
    // **レコードの `error` には入れない。**あれは試行ごと分母から外す札で、
    // カルテが作れなかっただけの回は板書と教え返しの測定が生きている。
    // 理由はここに残し、`score.ts` は形の違うカルテを数えない(件数の欄が出ない)。
    return { error: `カルテを作れませんでした: ${messageOf(error)}` };
  }
}

/**
 * 作り直しを断る `delivery` のかぶせもの(L1の `withoutRepair` と同じ理由)。
 *
 * `runLessonLoop` の `delivery` は `isClosed` まで見る(安全弁の `canContinue`)。
 * かぶせた側で持たないと**常に開いている板書**に見えて、上限で閉じたあとも
 * 往復を続けてしまう。ゲッタで素通しする。
 */
function withoutRepair(delivery: LessonLoopDelivery): LessonLoopDelivery {
  return {
    append: (appendOptions) => delivery.append({ ...appendOptions, maxRepairAttempts: 0 }),
    get isClosed() {
      return delivery.isClosed;
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
