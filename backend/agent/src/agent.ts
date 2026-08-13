import type { BoardStep, CompleteSessionRequest } from "@ai-sensei/contract";
import { type JobContext, type JobProcess, defineAgent, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as silero from "@livekit/agents-plugin-silero";
import {
  BoardChannel,
  type BoardDelivery,
  type TextStreamPublisher,
  createTextStreamBoardSink,
} from "./board.ts";
import { isClosingUtterance } from "./closing.ts";
import { type AgentConfig, loadConfig } from "./config.ts";
import {
  type AgentContext,
  type SessionContext,
  remainingSeconds,
  resolveAgentContext,
} from "./context.ts";
import {
  buildKarte,
  createAnthropicClient,
  emptyKarte,
  postComplete,
  withUncertaintyHole,
} from "./karte.ts";
import { boardCloseReasonFor, createAnthropicLessonClient, runBoardLesson } from "./lesson.ts";
import { JobLogger } from "./log.ts";
import { runPlanSession } from "./plan-session.ts";
import {
  handsTurnToStudent,
  lessonFailedPrompt,
  reviewOpening,
  senpaiBoardLessonPrompt,
  senpaiConversationPrompt,
  startsWithBoardLesson,
  teachBackFallback,
} from "./senpai.ts";
import { TranscriptCollector } from "./transcript.ts";

/**
 * 先輩AIのセッション。計画書 §2 のコアループの前半2つを回す。
 *
 *   フェーズ1「授業」  板書LLM → 手順単位で Text Streams → 直後にTTS(§3-2)
 *   フェーズ2「教え返し」 STT → 会話LLM(先輩) → TTS ← 既存のパイプライン
 *   終了時            transcript → カルテ → /complete ← 既存のまま
 *
 * WebRTCは書かない(LiveKit Agentsに乗る)。ここで書くのは、
 * 文脈の受け渡し・**授業と会話の切り替え**・上限時間の打ち切り・カルテ生成。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【板書の寿命】1セッション = 1つの問題 = 板書1枚
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `board_open` は最初の手順が確定したときに1度だけ、`board_close` は
 * **会話がぜんぶ終わってから**送る(`board.ts` の寿命の約束)。
 * 授業から教え返しへ移るときには閉じない — 生徒は板書を見ながら説明するので、
 * ここで閉じ直すと、いちばん要る瞬間に画面が白紙になる。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【transcript に入れるもの / 入れないもの】計画書 §2 の設計制約
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 授業中の先輩の発話は `addToChatCtx: false` で流す。理由は2つ:
 *
 *   1. 小テストの**出題元は「ユーザーが説明した内容」**で、AIが教えた内容から
 *      作らない(§2)。カルテの材料は transcript なので、ここに授業を混ぜると
 *      AIの誤読が1/3/7日で3回強化される — 計画書が最悪の失敗モードと呼んだ形。
 *   2. カルテを書くLLMに、**先輩の板書をユーザーの説明として読ませない**。
 *      transcript は「誰が何を言ったか」の記録で、教えた内容の記録ではない。
 *
 * 先輩が「何を教えたか」は instructions 側に渡す(`senpai.ts`)。
 */
export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // VADモデルのロードは重いので、ジョブが来る前に温めておく
    proc.userData["vad"] = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const config = loadConfig();
    const startedAt = new Date();
    let log = new JobLogger({ room: ctx.room.name, job_id: ctx.job.id });

    // ここが出ていなければ、ディスパッチが届いていない(ワーカー名・自動/明示の
    // 設定を疑う)。アプリからは「先輩が来ない」としか見えないので、必ず残す。
    log.info("job_started");

    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    let context: AgentContext;
    try {
      // 参加者metadata(自動ディスパッチ)とジョブmetadata(明示ディスパッチ)の
      // どちらで来ても読めるようにする。
      context = resolveAgentContext([participant.metadata, ctx.job.metadata]);
    } catch (error) {
      // 文脈なしで喋らせると、写真と関係ない一般論を教え始めてしまう。
      // それくらいなら黙って終える。
      log.error("context_unreadable", error, { participant: participant.identity });
      await ctx.room.disconnect();
      return;
    }

    if (context.kind === "plan") {
      // 計画は同じ声・同じLiveKitを使うが授業ではない。板書・カルテ・教え返しへ
      // 入る前に分岐し、計画を授業回数や穴へ混ぜない。
      log = log.child({ plan_session_id: context.plan_session_id });
      await runPlanSession({ ctx, config, context, startedAt, log });
      return;
    }

    log = log.child({ session_id: context.session_id });

    // 穴が届いた復習も板書授業から始める。`review` は小テストで「まだ」→「先輩に聞く」を
    // 選んだ**あと**のセッションなので、前回の穴をもう一度聞くだけの会話へ戻すと、
    // §2 の「詰まったら授業モードへ」がここで途切れる。写真の代わりに何を根拠に
    // 教えるかは `senpaiBoardLessonPrompt()` が review_hole から組み立てる。
    // 欄が無い復習は、古いAPIと共存する窓なので従来の会話へ安全に縮退する。
    const lessonMode = startsWithBoardLesson(context);

    const collector = new TranscriptCollector(startedAt, context);

    const session = new voice.AgentSession({
      vad: ctx.proc.userData["vad"] as never,
      // localeはAPIが受け付ける値なので、STTの言語もそれに合わせる。
      // 日本語のモデルのまま英語を流すと、認識が崩れて会話が成立しない。
      stt: new deepgram.STT({
        model: "nova-2-general",
        language: context.locale,
        interimResults: true,
      }),
      llm: new anthropic.LLM({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.LLM_MODEL_CONVERSATION,
        // 先輩の文体を安定させたいので、振れ幅は小さめにする
        temperature: 0.6,
      }),
      // 声は**言語ごとにモデルが分かれる**。1ボイスに言語を渡す作りではないので、
      // localeで選び分ける(日本語ボイスに英語を喋らせることはできない)。
      // SDK 1.6.1 の `TTSModels` は英語ボイスしか型に持たないが、`model` の型は
      // `TTSModels | string` で、実体はAPIへそのまま渡るだけなので日本語ボイスも通る。
      tts: new deepgram.TTS({
        apiKey: config.DEEPGRAM_API_KEY,
        model:
          context.locale === "en" ? config.DEEPGRAM_TTS_MODEL_EN : config.DEEPGRAM_TTS_MODEL_JA,
      }),
    });

    // 会話が自然に終わったことを、締めの発話で見る。
    // これがないと、うまく終わった会話も上限時間まで部屋が空回りする。
    let onClosing: (() => void) | undefined;

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item;
      if (!("role" in item)) return;
      const role = item.role === "assistant" ? "assistant" : "user";
      const text = textOf(item);
      collector.add({ role, text, at: new Date() });
      if (role === "assistant" && isClosingUtterance(text)) onClosing?.();
    });

    // 授業中に生徒が喋ったら板書の生成を止める合図。§3-2 が案Aを採った理由そのもの。
    const interrupt = new AbortController();

    // プロンプトは言語ごとに別本(`prompts/<id>.<locale>.md`)。
    // 日本語の本文に「英語で答えて」を足す作りだと、ペルソナも禁止事項も
    // 日本語のまま薄く言い直されるだけで、範囲外に滑りやすくなる。
    const agent = new LessonAwareAgent({
      // 復習も授業も**同じ先輩**。ピボット(§0 決定3)で配役は1つになったので、
      // モードで人格を出し分けない。授業モードではこの時点で板書の要約がまだ無く、
      // 授業が終わってから `updateInstructions` で足す(割り込まれたときは、
      // このままの指示で先輩がその発話に答える)。
      instructions: senpaiConversationPrompt({ context, remainingSeconds: context.max_seconds }),
      lessonRunning: lessonMode,
      onInterrupted: () => {
        log.info("lesson_interrupted_by_user");
        interrupt.abort();
      },
    });

    await session.start({ agent, room: ctx.room });

    // **授業を始める前に出す。**授業は数分かかるので、ここを授業のあとに置くと
    // 「セッションは始まっているのに、始まったログが無い」時間帯ができる。
    // その間に落ちたときに、どこまで行っていたのかが読めなくなる。
    log.info("conversation_started", {
      kind: context.kind,
      locale: context.locale,
      max_seconds: context.max_seconds,
      topics: context.allowed_topic_ids.length,
      lesson_mode: lessonMode,
    });

    // 上限秒数はサーバが決める。クライアントにもエージェントにも延ばさせない。
    //
    // **授業より先に張る。**授業は数分かかるので、あとに張ると
    // その間の離脱(`Close`)とエラーを取りこぼす。イベントは1度きりなので、
    // 取りこぼすと上限時間が来るまで**誰もいない部屋が回り続ける**
    // (無料5分ならまだしも、Premium15分だとその全部を待つ)。
    const ended = waitForEnd(session, context, startedAt, (handler) => {
      onClosing = handler;
    });
    // 終わったのに板書を作り続けない。生徒が抜けたあとのLLM出力は誰も見ない。
    void ended.then(() => interrupt.abort());

    let board: BoardDelivery | undefined;
    if (lessonMode) {
      board = await teachWithBoard({
        ctx,
        config,
        context,
        session,
        agent,
        startedAt,
        signal: interrupt.signal,
        log,
      });
    } else {
      // 新しいagentを先に出した窓では、古いAPIの復習metadataに review_hole が無い。
      // 根拠なしの板書を作らず従来の聞き直し会話へ落とし、窓が閉じないまま運用が
      // 続いても気づけるよう縮退を必ず記録する。
      log.warn("review_hole_missing", { kind: context.kind });
      session.say(reviewOpening(context.locale));
    }

    const endedReason = await ended;

    // 会話はここで終わり。カルテ生成(数秒かかる)を待たせないよう、
    // 先に部屋を閉じる。開けたままだと上限時間を超えて話し続けられてしまう。
    const endedAt = new Date();
    await session.close().catch(() => undefined);

    // **板書を締めるのはここだけ。**1つの問題が終わったので閉じる(§3-2)。
    // セッションを閉じたあとに送るのは、締めの封筒より先に声を止めたいから
    // (`sendText` が詰まっても、生徒には「先輩が喋り続ける」に見えない)。
    await board?.close(boardCloseReasonFor(endedReason));

    const transcript = collector.all;
    log.info("conversation_ended", {
      ended_reason: endedReason,
      duration_seconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
      turns: transcript.length,
      user_spoke: collector.hasUserSpeech,
      board_steps: board?.stepCount ?? 0,
    });

    const karteStartedAt = Date.now();
    const drafted = collector.hasUserSpeech
      ? await buildKarte({
          context,
          transcript,
          llm: createAnthropicClient({
            apiKey: config.ANTHROPIC_API_KEY,
            model: config.LLM_MODEL_KARTE,
          }),
        })
          .then((draft) => {
            log.info("karte_built", {
              holes: draft.holes.length,
              said_well: draft.said_well.length,
              took_ms: Date.now() - karteStartedAt,
            });
            return draft;
          })
          .catch((error) => {
            // 空のカルテでも会話は完了扱いにする。ここで投げると、
            // 進捗も復習予約も残らない。
            log.error("karte_failed", error, { took_ms: Date.now() - karteStartedAt });
            return emptyKarte();
          })
      : emptyKarte();

    // 「わからない」と言ったのに穴ゼロ、を出さない。
    // LLMが書けなかったときも(上の catch を通ったときも)ここを通る。
    const karte = withUncertaintyHole(drafted, context, transcript);
    if (karte.holes.length > drafted.holes.length) {
      log.info("karte_uncertainty_hole_added", { session_id: context.session_id });
    }

    // review_outcome はここでは立てない。言えたかどうかを決めるのは本人で、
    // 会話から推測すると §2 が却下した「AIによる採点」になる。
    // 申告はアプリの二択から届く。
    const body: CompleteSessionRequest = {
      transcript,
      karte,
      // 会話が終わった時刻で測る。カルテ生成のレイテンシを混ぜると、
      // 上限5分のセッションが6分と記録されてしまう。
      duration_seconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
      ended_reason: endedReason,
    };

    try {
      await postComplete({
        apiBaseUrl: config.API_BASE_URL,
        internalToken: config.INTERNAL_API_TOKEN,
        sessionId: context.session_id,
        body,
      });
      log.info("complete_posted", { holes: karte.holes.length });
    } catch (error) {
      // ここで落ちると、会話は成立したのにカルテが存在しないことになる。
      // アプリからは「カルテが出ない」としか見えないので、必ず表に出す。
      log.error("complete_failed", error, { ended_reason: endedReason });
    }
  },
});

/**
 * 会話パイプラインの `voice.Agent`。**授業中かどうかを知っている**だけの薄い派生。
 *
 * 授業は `session` の外(直接のAnthropic呼び出し)で回っているので、
 * その最中に生徒が喋ると、会話LLMが板書と無関係な返事を被せてくる。
 * それを止める口が `onUserTurnCompleted`(フレームワークが返事を作る直前に呼ぶ)。
 *
 * **ここで `StopResponse` は投げない。**投げると返事が消えるだけでなく、
 * その発話が chatCtx にも `ConversationItemAdded` にも載らない
 * (`agent_activity.js` は StopResponse のとき userMessage を捨てる)。
 * つまり**生徒の質問が黙殺され、カルテの材料からも消える**。
 * 代わりに授業のほうを止めて、会話モードへ渡す — 生徒が口を開いた時点で、
 * その問題の主導権は生徒に移っている。
 *
 * 割り込みの検出に VAD の発話開始(`UserStateChanged`)を使わないのは、
 * 咳や生活音で授業が落ちるのを避けるため。ここまで来た発話は
 * **STTが文字を起こせたもの**なので、誤検出でレッスンが飛ぶ確率が一段低い。
 */
class LessonAwareAgent extends voice.Agent {
  private lessonRunning: boolean;
  private readonly onInterrupted: () => void;

  constructor(options: {
    instructions: string;
    lessonRunning: boolean;
    onInterrupted: () => void;
  }) {
    super({ instructions: options.instructions });
    this.lessonRunning = options.lessonRunning;
    this.onInterrupted = options.onInterrupted;
  }

  /** 授業を終える(正常終了・割り込みのどちらでも通る)。以降はふつうの会話。 */
  endLesson(): void {
    this.lessonRunning = false;
  }

  override async onUserTurnCompleted(): Promise<void> {
    if (!this.lessonRunning) return;
    this.lessonRunning = false;
    this.onInterrupted();
  }
}

type TeachOptions = {
  ctx: JobContext;
  config: AgentConfig;
  context: SessionContext;
  session: voice.AgentSession;
  agent: LessonAwareAgent;
  startedAt: Date;
  signal: AbortSignal;
  log: JobLogger;
};

/**
 * フェーズ1「授業」を回し、そのまま フェーズ2「教え返し」へ渡す。
 *
 * 戻り値は開いた板書(締めるのは呼び出し側 = セッションの終わり)。
 * 板書チャネルが作れなかったときは `undefined` を返し、**会話だけで続ける** —
 * 板書が出ないのは大きな劣化だが、黙って部屋を閉じるよりはるかにまし。
 */
async function teachWithBoard(options: TeachOptions): Promise<BoardDelivery | undefined> {
  const { ctx, config, context, session, agent, startedAt, signal, log } = options;

  const publisher = ctx.room.localParticipant as TextStreamPublisher | undefined;
  if (publisher === undefined) {
    // 接続直後に必ず入っている値なので、ここに来るのはフレームワーク側の異常。
    log.warn("board_publisher_missing");
    agent.endLesson();
    session.say(lessonFailedPrompt(context.locale, context.kind));
    return undefined;
  }

  const channel = new BoardChannel({
    sessionId: context.session_id,
    locale: context.locale,
    sink: createTextStreamBoardSink(publisher),
    // **教える範囲の妥当性**を見るための許可集合(計画書 §8)。
    // 見出しの `topic_ids` がここから外れていたら作り直させる。
    // 前提2段ぶんは backend/api が既に入れてくるので、こちらでは広げない。
    allowedTopicIds: context.allowed_topic_ids,
    log,
  });
  const board = channel.startBoard();

  // 冒頭の一言はモバイルが同梱アセットから鳴らす(§3-2)。ここでも同じ文を
  // `session.say()` すると、固定文に毎回 Deepgram の従量原価が戻るだけでなく、
  // ローカル音声と重なって「先輩が2人いる」ように聞こえる。agent はすぐ板書生成へ
  // 入り、最初の手順または発話が届いた時点でモバイル側がアセットを止める。

  const lesson = await runBoardLesson({
    llm: createAnthropicLessonClient({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.LLM_MODEL_BOARD,
    }),
    // 新規は写真の問題、復習は review_hole を根拠にする。どちらも同じ板書規約を
    // 通すが、穴を problem_text に偽装しない(`senpai.ts` の設計判断)。
    system: senpaiBoardLessonPrompt({
      context,
      remainingSeconds: remainingSeconds(context, startedAt, new Date()),
    }),
    locale: context.locale,
    delivery: board,
    signal,
    log,
    // **板書を出してから喋る**(§3-2)。読み上げ終わりまで待つのは、
    // 待たないと板書だけが何行も先に進んで、音声が指す行と画面がずれるから。
    // 代償は、作り直し(`defaultMaxRepairAttempts`)の待ちが音声の空白として
    // そのまま出ること。どちらを採るかはW1のドッグフーディングで決める値。
    speak: (step: BoardStep) => sayAndWait(session, step.speech, log, { addToChatCtx: false }),
  });

  // **手順数ではなく「板書に何行載ったか」を見る。**手順数だけを記録していたので、
  // 音声だけの手順が並んだ授業(= 生徒の画面は白いまま)が成功として通っていた。
  const written = lesson.steps.filter((step) => step.board !== null).length;
  log.info("lesson_finished", {
    board_id: lesson.board_id,
    opened: lesson.opened,
    steps: lesson.step_count,
    // 0 なら黒板は見出しだけで空。
    written,
    reason: lesson.reason,
    rejections: lesson.rejections.length,
  });

  // 教え返しでは「何を教えたか」を先輩が知っている必要がある。
  // 板書の要約は**instructions にだけ**入れる(transcript には入れない・上の説明)。
  await agent
    .updateInstructions(
      senpaiConversationPrompt({
        context,
        remainingSeconds: remainingSeconds(context, startedAt, new Date()),
        lesson: lesson.steps,
      }),
    )
    .catch((error) => {
      // 差し替えに失敗しても会話は続く(授業前の先輩の指示のままになる)。
      log.error("instructions_update_failed", error);
    });

  agent.endLesson();

  if (lesson.step_count === 0) {
    // 1行も出せなかった。教わっていないことの説明は求められない。
    log.warn("lesson_empty", { board_id: lesson.board_id, reason: lesson.reason });
    session.say(lessonFailedPrompt(context.locale, context.kind));
    return board;
  }

  if (signal.aborted) {
    // 生徒がもう喋っている。会話LLMがその発話に答えるので、こちらからは何も言わない。
    return board;
  }

  // **手順は出たのに、板書には1行も載らなかった。**
  //
  // 検証に落ちた手順を直すときの逃げ道が `board: null` だったころは、ここが
  // 「成功した授業」として通り抜けていた(`lesson_finished` は手順数しか見ていない)。
  // 生徒の画面は見出しだけの白い黒板で、先輩だけが喋り続ける。
  //
  // ただし**問いかけで終わった回は正常**(切り分けの質問は `board: null` が正しい形)。
  // 番を渡していれば黙って待つ — ここで立て直しの一言を足すと、答えようとしている
  // 生徒に「板書が出せなかった」と被せることになる。
  if (written === 0 && !handsTurnToStudent(lesson.steps.at(-1)?.speech ?? "", context.locale)) {
    log.warn("lesson_wrote_nothing", {
      board_id: lesson.board_id,
      steps: lesson.step_count,
      reason: lesson.reason,
      rejections: lesson.rejections.length,
    });
    session.say(lessonFailedPrompt(context.locale, context.kind));
    return board;
  }

  // プロンプトが番を渡し忘れても「教えて終わり」にしない。一方、もう渡して
  // いるときは同じ問いを二度重ねない。実際に配送できた手順だけで決める。
  const fallback = teachBackFallback(context, lesson.steps);
  if (fallback !== null) session.say(fallback);

  return board;
}

/**
 * 喋って、読み上げが終わるまで待つ。
 *
 * **例外を外に出さない。**`say()` はセッションが閉じかけているときに投げる
 * (`AgentSession is closing, cannot use say()`)。授業の途中で上限時間が来た、
 * 生徒が退出した、のどちらでも起きる普通の経路で、そこで授業が例外で落ちると
 * 板書が締まらないまま `board_close` を送りそこねる。
 */
async function sayAndWait(
  session: voice.AgentSession,
  text: string,
  log: JobLogger,
  options?: { addToChatCtx?: boolean },
): Promise<void> {
  try {
    await session.say(text, options).waitForPlayout();
  } catch (error) {
    log.warn("say_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

type EndedReason = CompleteSessionRequest["ended_reason"];

/**
 * 上限時間・ユーザーの離脱・エラーのいずれかで終わるまで待つ。
 * どれで終わったかは ended_reason としてカルテ側の重み付けに使う。
 */
function waitForEnd(
  session: voice.AgentSession,
  context: SessionContext,
  startedAt: Date,
  registerClosing: (handler: () => void) => void,
): Promise<EndedReason> {
  return new Promise<EndedReason>((resolve) => {
    let settled = false;
    const finish = (reason: EndedReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };

    const timer = setTimeout(
      () => finish("timeout"),
      remainingSeconds(context, startedAt, new Date()) * 1000,
    );

    // SDK 1.6.1 の `voice/agent_activity.js` で確認: `forwardSegment` の約2180・2191行は
    // `audioOutput.waitForPlayout()` を await してから返り、約2350行でその後に
    // `_conversationItemAdded(assistantMessage)` を呼ぶ。固定時間で待つと長い締めを推測で
    // 切ることになるため、検出した時点で完了にする。
    registerClosing(() => {
      finish("completed");
    });

    session.on(voice.AgentSessionEventTypes.Close, () => finish("user_left"));
    session.on(voice.AgentSessionEventTypes.Error, () => finish("error"));
  });
}

function textOf(item: { content?: unknown; textContent?: unknown }): string {
  if (typeof item.textContent === "string") return item.textContent;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content.filter((part): part is string => typeof part === "string").join(" ");
  }
  return "";
}
