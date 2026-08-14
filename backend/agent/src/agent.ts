import type { BoardStep, CompleteSessionRequest } from "@ai-sensei/contract";
import { type JobContext, type JobProcess, defineAgent, voice } from "@livekit/agents";
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
import { observeVoiceMetrics } from "./voice-metrics.ts";
import { createVoiceSession } from "./voice-session.ts";

/**
 * Senpai AI session. Runs the first two halves of the core loop (plan §2).
 *
 *   Phase 1 "lesson"     board LLM -> Text Streams per step -> TTS right after (§3-2)
 *   Phase 2 "teach-back" STT -> conversation LLM (senpai) -> TTS (existing pipeline)
 *   On end               transcript -> karte -> /complete (unchanged)
 *
 * No WebRTC here (LiveKit Agents handles it). This file owns context handoff,
 * lesson/conversation switching, the time cap, and karte generation.
 *
 * Board lifetime: 1 session = 1 problem = 1 board.
 *
 * `board_open` fires once when the first step is settled; `board_close` only
 * after the whole conversation ends (the lifetime contract in `board.ts`).
 * Do not close when moving from lesson to teach-back - the student explains
 * while looking at the board, so closing here blanks the screen exactly when
 * it is needed most.
 *
 * What goes into the transcript (design constraint, plan §2):
 *
 * Senpai speech during the lesson is sent with `addToChatCtx: false`, for two
 * reasons:
 *
 *   1. Quiz questions come from what the *user* explained, never from what the
 *      AI taught (§2). The karte is built from the transcript, so mixing the
 *      lesson in reinforces an AI misreading three times over 1/3/7 days - the
 *      worst failure mode named in the plan.
 *   2. The karte LLM must not read the senpai's board as the user's own words.
 *      The transcript records who said what, not what was taught.
 *
 * What the senpai taught is passed via instructions instead (`senpai.ts`).
 */
export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Loading the VAD model is slow, so warm it up before jobs arrive.
    proc.userData["vad"] = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const config = loadConfig();
    const startedAt = new Date();
    let log = new JobLogger({ room: ctx.room.name, job_id: ctx.job.id });

    // If this is missing, dispatch never arrived (suspect worker name or
    // auto/explicit config). The app only shows "senpai never came", so keep it.
    log.info("job_started");

    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    let context: AgentContext;
    try {
      // Readable whether it arrives as participant metadata (auto dispatch) or
      // job metadata (explicit dispatch).
      context = resolveAgentContext([participant.metadata, ctx.job.metadata]);
    } catch (error) {
      // Speaking without context means teaching generalities unrelated to the
      // photo. Better to end quietly.
      log.error("context_unreadable", error, { participant: participant.identity });
      await ctx.room.disconnect();
      return;
    }

    if (context.kind === "plan") {
      // Planning uses the same voice and LiveKit but is not a lesson. Branch
      // before board/karte/teach-back so it never counts as a lesson or a hole.
      log = log.child({ plan_session_id: context.plan_session_id });
      await runPlanSession({ ctx, config, context, startedAt, log });
      return;
    }

    log = log.child({ session_id: context.session_id });

    // Reviews that carry a hole also start with a board lesson. `review` runs
    // *after* the quiz answer "not yet" -> "ask senpai", so falling back to a
    // conversation that just re-asks the old hole breaks §2's "stuck -> lesson
    // mode" here. `senpaiBoardLessonPrompt()` builds the basis from review_hole
    // instead of the photo. Reviews without the field degrade safely to the old
    // conversation, for compatibility with the previous API.
    const lessonMode = startsWithBoardLesson(context);

    const collector = new TranscriptCollector(startedAt, context);

    const session = createVoiceSession({
      ctx,
      config,
      locale: context.locale,
      llmTemperature: 0.6,
    });
    // Measure latency and barge-in from the first utterance; after start() the
    // first turn is already lost.
    const voiceMetrics = observeVoiceMetrics(session, log);

    // Detect a natural end from the closing utterance. Without it, a
    // well-finished conversation still idles until the time cap.
    let onClosing: (() => void) | undefined;

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item;
      if (!("role" in item)) return;
      const role = item.role === "assistant" ? "assistant" : "user";
      const text = textOf(item);
      collector.add({ role, text, at: new Date() });
      if (role === "assistant" && isClosingUtterance(text)) onClosing?.();
    });

    // Signal to stop board generation when the student speaks mid-lesson - the
    // very reason §3-2 chose option A.
    const interrupt = new AbortController();

    // Prompts are separate books per language (`prompts/<id>.<locale>.md`).
    // Appending "answer in English" to a Japanese body only restates the persona
    // and the bans thinly in Japanese, making it easier to drift off-scope.
    const agent = new LessonAwareAgent({
      // Same senpai for review and lesson alike. The pivot (§0 decision 3) left
      // one cast, so persona does not change by mode. In lesson mode there is no
      // board summary yet; it is added after the lesson via `updateInstructions`
      // (when interrupted, the senpai answers with these instructions as-is).
      instructions: senpaiConversationPrompt({ context, remainingSeconds: context.max_seconds }),
      lessonRunning: lessonMode,
      onInterrupted: () => {
        log.info("lesson_interrupted_by_user");
        interrupt.abort();
      },
    });

    await session.start({ agent, room: ctx.room });

    // Emit *before* the lesson starts. The lesson takes minutes, so logging
    // after it leaves a window where the session is running with no start log,
    // and a crash inside it hides how far we got.
    log.info("conversation_started", {
      kind: context.kind,
      locale: context.locale,
      max_seconds: context.max_seconds,
      topics: context.allowed_topic_ids.length,
      lesson_mode: lessonMode,
    });

    // The server owns the cap in seconds; neither client nor agent may extend it.
    //
    // Register *before* the lesson. The lesson takes minutes, so registering
    // after it drops departures (`Close`) and errors in between. These events
    // fire once, so a miss leaves an empty room spinning until the cap (bad at
    // 5 free minutes, worse at 15 Premium ones).
    const ended = waitForEnd(session, context, startedAt, (handler) => {
      onClosing = handler;
    });
    // Stop producing board content once ended; nobody reads LLM output after
    // the student leaves.
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
      // In the window where the new agent shipped first, old-API review metadata
      // has no review_hole. Rather than a board with no basis, fall back to the
      // old re-ask conversation, and always log the degradation so a window that
      // never closes is still visible.
      log.warn("review_hole_missing", { kind: context.kind });
      session.say(reviewOpening(context.locale));
    }

    const endedReason = await ended;

    // The conversation ends here. Close the room first so karte generation
    // (a few seconds) is not waited on; leaving it open lets talk run past the cap.
    const endedAt = new Date();
    await session.close().catch(() => undefined);

    // The only place the board is closed: one problem is done (§3-2). Sent after
    // closing the session so the voice stops before the closing envelope (a stuck
    // `sendText` must not look like "senpai keeps talking").
    await board?.close(boardCloseReasonFor(endedReason));

    const transcript = collector.all;
    log.info("conversation_ended", {
      ended_reason: endedReason,
      duration_seconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
      turns: transcript.length,
      user_spoke: collector.hasUserSpeech,
      board_steps: board?.stepCount ?? 0,
      ...voiceMetrics.summary(endedAt),
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
            // An empty karte still counts as a completed conversation. Throwing
            // here would leave neither progress nor a review booking.
            log.error("karte_failed", error, { took_ms: Date.now() - karteStartedAt });
            return emptyKarte();
          })
      : emptyKarte();

    // Never show zero holes after the student said "I don't get it" - including
    // when the LLM failed and we came through the catch above.
    const karte = withUncertaintyHole(drafted, context, transcript);
    if (karte.holes.length > drafted.holes.length) {
      log.info("karte_uncertainty_hole_added", { session_id: context.session_id });
    }

    // review_outcome is not set here. Only the student decides whether they said
    // it; inferring from the conversation is the "AI grading" §2 rejected. The
    // self-report arrives from the app's two-button choice.
    const body: CompleteSessionRequest = {
      transcript,
      karte,
      // Measured at the end of the conversation. Mixing in karte latency would
      // record a 5-minute-cap session as 6 minutes.
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
      // Failing here means the conversation happened but no karte exists. The
      // app only shows "no karte", so always surface it.
      log.error("complete_failed", error, { ended_reason: endedReason });
    }
  },
});

/**
 * The conversation pipeline's `voice.Agent`. A thin subclass that only knows
 * whether a lesson is running.
 *
 * The lesson runs outside `session` (direct Anthropic calls), so a student
 * speaking mid-lesson makes the conversation LLM talk over it with a reply
 * unrelated to the board. `onUserTurnCompleted` (called just before the
 * framework builds a reply) is where that is stopped.
 *
 * Do not throw `StopResponse` here. It drops the reply *and* keeps the
 * utterance out of chatCtx and `ConversationItemAdded` (`agent_activity.js`
 * discards userMessage on StopResponse) - the student's question is ignored
 * and vanishes from the karte's inputs. Stop the lesson instead and hand over
 * to conversation mode: once the student speaks, the problem is theirs.
 *
 * VAD speech start (`UserStateChanged`) is not used to detect barge-in, to
 * avoid coughs and background noise killing the lesson. Utterances that reach
 * here were transcribed by STT, so a false positive is far less likely.
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

  /** End the lesson (normal finish or barge-in). Plain conversation follows. */
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
 * Runs phase 1 "lesson" and hands straight over to phase 2 "teach-back".
 *
 * Returns the opened board (the caller closes it at the end of the session).
 * Returns `undefined` if the board channel could not be created and continues
 * with conversation only - losing the board is a big degradation, but far
 * better than silently closing the room.
 */
async function teachWithBoard(options: TeachOptions): Promise<BoardDelivery | undefined> {
  const { ctx, config, context, session, agent, startedAt, signal, log } = options;

  const publisher = ctx.room.localParticipant as TextStreamPublisher | undefined;
  if (publisher === undefined) {
    // Always present right after connecting, so reaching here means a framework
    // anomaly.
    log.warn("board_publisher_missing");
    agent.endLesson();
    session.say(lessonFailedPrompt(context.locale, context.kind));
    return undefined;
  }

  const channel = new BoardChannel({
    sessionId: context.session_id,
    locale: context.locale,
    sink: createTextStreamBoardSink(publisher),
    // Allow-set used to check the *scope* of what may be taught (plan §8).
    // If a heading's `topic_ids` fall outside it, force a rebuild. backend/api
    // already includes two levels of prerequisites, so do not widen here.
    allowedTopicIds: context.allowed_topic_ids,
    log,
  });
  const board = channel.startBoard();

  // Mobile plays the opening line from a bundled asset (§3-2). Saying the same
  // line via `session.say()` would put Deepgram per-use cost back on a fixed
  // string and overlap the local audio, sounding like "two senpai". The agent
  // goes straight to board generation; mobile stops the asset once the first
  // step or utterance arrives.

  const lesson = await runBoardLesson({
    llm: createAnthropicLessonClient({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.LLM_MODEL_BOARD,
    }),
    // New sessions are based on the photographed problem, reviews on review_hole.
    // Both go through the same board contract, but a hole is never disguised as
    // problem_text (design decision in `senpai.ts`).
    system: senpaiBoardLessonPrompt({
      context,
      remainingSeconds: remainingSeconds(context, startedAt, new Date()),
    }),
    locale: context.locale,
    delivery: board,
    signal,
    log,
    // Write the board, then speak (§3-2). We wait for playout to finish because
    // otherwise the board runs several lines ahead and the audio no longer points
    // at what is on screen. The cost is that repair waits
    // (`defaultMaxRepairAttempts`) show up as audio gaps. Which to keep is a W1
    // dogfooding call.
    speak: (step: BoardStep) => sayAndWait(session, step.speech, log, { addToChatCtx: false }),
  });

  // Count lines actually written to the board, not steps. Logging only step
  // count let a lesson of speech-only steps (= a blank screen) pass as success.
  const written = lesson.steps.filter((step) => step.board !== null).length;
  log.info("lesson_finished", {
    board_id: lesson.board_id,
    opened: lesson.opened,
    steps: lesson.step_count,
    // 0 means the board holds only the heading.
    written,
    reason: lesson.reason,
    rejections: lesson.rejections.length,
  });

  // Teach-back needs the senpai to know what was taught. The board summary goes
  // into instructions *only* - never the transcript (see the header).
  await agent
    .updateInstructions(
      senpaiConversationPrompt({
        context,
        remainingSeconds: remainingSeconds(context, startedAt, new Date()),
        lesson: lesson.steps,
      }),
    )
    .catch((error) => {
      // The conversation survives a failed swap (senpai keeps its pre-lesson
      // instructions).
      log.error("instructions_update_failed", error);
    });

  agent.endLesson();

  if (lesson.step_count === 0) {
    // Not a single line came out. You cannot ask someone to explain what they
    // were never taught.
    log.warn("lesson_empty", { board_id: lesson.board_id, reason: lesson.reason });
    session.say(lessonFailedPrompt(context.locale, context.kind));
    return board;
  }

  if (signal.aborted) {
    // The student is already speaking; the conversation LLM answers, so say
    // nothing here.
    return board;
  }

  // Steps came out, but not one line reached the board.
  //
  // Back when `board: null` was the escape hatch for repairing a step that
  // failed validation, this passed as a "successful lesson" (`lesson_finished`
  // only looked at step count). The student sees a blank board with just a
  // heading while the senpai talks on.
  //
  // A run that ends on a question is fine, though - a diagnostic question is
  // correctly `board: null`. If the turn was handed over, wait quietly: adding
  // a recovery line here talks over a student who is trying to answer.
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

  // Never end on "taught and done" just because the prompt forgot to hand over
  // the turn - but do not repeat the question when it already did. Decided from
  // the steps actually delivered.
  const fallback = teachBackFallback(context, lesson.steps);
  if (fallback !== null) session.say(fallback);

  return board;
}

/**
 * Speak, and wait until playout finishes.
 *
 * Never lets exceptions escape. `say()` throws while the session is closing
 * (`AgentSession is closing, cannot use say()`), which happens on the ordinary
 * paths of hitting the cap mid-lesson or the student leaving. A lesson dying
 * there would leave the board unclosed and miss `board_close`.
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
 * Waits until the session ends by time cap, user departure, or error.
 * Which one it was becomes ended_reason, used to weight the karte.
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

    // Verified in SDK 1.6.1 `voice/agent_activity.js`: `forwardSegment` around
    // lines 2180/2191 awaits `audioOutput.waitForPlayout()` before returning, and
    // around line 2350 calls `_conversationItemAdded(assistantMessage)` after it.
    // A fixed wait would guess-cut a long closing, so finish on detection.
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
