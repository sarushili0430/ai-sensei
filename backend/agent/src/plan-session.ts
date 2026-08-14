import type { CompletePlanSessionRequest, PlanSource, StudyPlanDraft } from "@ai-sensei/contract";
import { topicsForTracks, tracksForStage } from "@ai-sensei/curriculum";
import { formatTopicIndex, studyPlanSystemPrompt } from "@ai-sensei/prompts";
import {
  type ChatChunk,
  type ChatContext,
  type FlushSentinel,
  type JobContext,
  type ModelSettings,
  type ToolContext,
  voice,
} from "@livekit/agents";
import type { AgentConfig } from "./config.ts";
import { type PlanSessionContext, remainingSeconds } from "./context.ts";
import type { JobLogger } from "./log.ts";
import {
  type PlanTurnInspection,
  buildTemplatePlan,
  inspectPlanTurn,
  postPlanComplete,
} from "./study-plan.ts";
import { observeVoiceMetrics } from "./voice-metrics.ts";
import { createVoiceSession } from "./voice-session.ts";

type ReadyPlan = {
  plan: StudyPlanDraft;
  source: PlanSource;
  speech: string;
};

export async function runPlanSession(input: {
  ctx: JobContext;
  config: AgentConfig;
  context: PlanSessionContext;
  startedAt: Date;
  log: JobLogger;
}): Promise<void> {
  const { ctx, config, context, startedAt, log } = input;
  const state: {
    ready: ReadyPlan | null;
    finish: ((reason: CompletePlanSessionRequest["ended_reason"]) => void) | null;
  } = { ready: null, finish: null };

  const session = createVoiceSession({
    ctx,
    config,
    locale: context.locale,
    llmTemperature: 0.4,
  });
  // Planning shares the conversation stack, so quality is comparable on the same
  // scale from before it starts.
  const voiceMetrics = observeVoiceMetrics(session, log);

  const agent = new PlanVoiceAgent({
    context,
    startedAt,
    log,
    onReady: (next) => {
      // We arrive here before llmNode returns speech only. Do not close until TTS
      // finishes; complete the moment AgentStateChanged below leaves speaking.
      state.ready = next;
    },
  });

  const ended = new Promise<CompletePlanSessionRequest["ended_reason"]>((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => settle("timeout"),
      remainingSeconds(context, startedAt, new Date()) * 1000,
    );

    const settle = (reason: CompletePlanSessionRequest["ended_reason"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };
    state.finish = settle;

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      // The complete that puts the plan on screen is sent after the last proposal
      // is read out. Closing right after llmNode passes JSON validation but the
      // student never hears the final line.
      if (state.ready !== null && event.oldState === "speaking" && event.newState !== "speaking") {
        settle("completed");
      }
    });
    session.on(voice.AgentSessionEventTypes.Close, () => settle("user_left"));
    session.on(voice.AgentSessionEventTypes.Error, () => settle("error"));
  });

  await session.start({ agent, room: ctx.room });
  log.info("plan_conversation_started", {
    locale: context.locale,
    has_current_plan: context.current_plan !== null,
    max_seconds: context.max_seconds,
  });

  // First run asks the first of three questions; a redo asks only about the facts
  // that broke. No form inputs at all.
  const opening =
    context.current_plan === null
      ? context.locale === "en"
        ? "When's the test?"
        : "テスト、いつ?"
      : context.locale === "en"
        ? "Tell me what changed. We'll redo it."
        : "どこが崩れたか、教えて。組み直そっか。";
  try {
    await session.say(opening).waitForPlayout();
  } catch (error) {
    log.warn("plan_opening_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    state.finish?.("error");
  }

  const endedReason = await ended;
  const endedAt = new Date();
  await session.close().catch(() => undefined);
  const durationSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);

  log.info("plan_conversation_ended", {
    ended_reason: endedReason,
    duration_seconds: durationSeconds,
    plan_ready: state.ready !== null,
    source: state.ready?.source ?? null,
    ...voiceMetrics.summary(endedAt),
  });
  const ready = state.ready;
  if (ready === null) {
    // If they leave before the facts are in, never invent a test date or their own
    // words and save an empty plan.
    log.warn("plan_not_completed", { ended_reason: endedReason });
    return;
  }

  const body: CompletePlanSessionRequest = {
    plan: ready.plan,
    source: ready.source,
    duration_seconds: durationSeconds,
    ended_reason: endedReason,
  };
  try {
    await postPlanComplete({
      apiBaseUrl: config.API_BASE_URL,
      internalToken: config.INTERNAL_API_TOKEN,
      planSessionId: context.plan_session_id,
      body,
    });
    log.info("plan_complete_posted", { source: ready.source, days: ready.plan.days.length });
  } catch (error) {
    log.error("plan_complete_failed", error, { ended_reason: endedReason, source: ready.source });
  }
}

/**
 * An agent that keeps the plan LLM's JSON out of TTS and returns only `speech`
 * to the conversation pipeline. Returning raw JSON makes the senpai read out
 * every bracket, topic_id and fraction, and mixes the plan body into mobile's
 * captions. The plan goes on screen; the voice only asks short questions.
 */
class PlanVoiceAgent extends voice.Agent {
  private readonly context: PlanSessionContext;
  private readonly log: JobLogger;
  private readonly onReady: (ready: ReadyPlan) => void;

  constructor(input: {
    context: PlanSessionContext;
    startedAt: Date;
    log: JobLogger;
    onReady: (ready: ReadyPlan) => void;
  }) {
    super({
      instructions: studyPlanSystemPrompt(
        {
          today: input.context.today,
          // No photo, so the scope cannot be narrowed: paste every topic at this
          // level.
          //
          // Learning goals are dropped (`formatTopicIndex`). The plan LLM's only
          // job is picking the scope's topic_ids, and goals do not inform that
          // choice. Measured on 52 Japanese high-school math entries:
          // 6,516 chars -> 2,503 (-61%).
          allowed_topics: formatTopicIndex(
            topicsForTracks(tracksForStage(input.context.school_stage, input.context.locale)),
            input.context.locale,
          ),
          known_facts: knownFacts(input.context),
          current_plan: currentPlan(input.context),
          remaining_seconds: remainingSeconds(input.context, input.startedAt, new Date()),
        },
        input.context.locale,
      ),
    });
    this.context = input.context;
    this.log = input.log;
    this.onReady = input.onReady;
  }

  override async llmNode(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null> {
    const raw = await this.collect(super.llmNode(chatCtx, toolCtx, modelSettings));
    let inspected = inspectPlanTurn(raw, {
      locale: this.context.locale,
      today: this.context.today,
      currentPlan: this.context.current_plan,
    });

    if (inspected.kind === "repair") {
      this.log.warn("plan_regeneration_requested", { reason: inspected.reason });
      const repairContext = chatCtx.copy();
      // Put the broken output and the repair reason in the same context. Given the
      // reason alone, the model cannot tell what to fix and rewrites the scope it
      // heard to make things add up.
      repairContext.addMessage({ role: "assistant", content: raw.slice(0, 20_000) });
      repairContext.addMessage({
        role: "user",
        content: `${inspected.guidance}\nJSONだけを返してください。`,
      });
      const repairedRaw = await this.collect(super.llmNode(repairContext, toolCtx, modelSettings));
      inspected = inspectPlanTurn(repairedRaw, {
        locale: this.context.locale,
        today: this.context.today,
        currentPlan: this.context.current_plan,
        finalAttempt: true,
      });
    }

    return this.toSpeech(inspected);
  }

  private async collect(
    streamPromise: Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null>,
  ): Promise<string> {
    const stream = await streamPromise;
    if (!stream) throw new Error("計画LLMのストリームがありません");
    let raw = "";
    for await (const chunk of stream) {
      if (typeof chunk === "string") raw += chunk;
      else if (typeof chunk !== "symbol") raw += chunk.delta?.content ?? "";
    }
    return raw;
  }

  private toSpeech(
    inspected: PlanTurnInspection,
  ): ReadableStream<ChatChunk | string | FlushSentinel> {
    if (inspected.kind === "question") return speechStream(inspected.turn.speech);

    if (inspected.kind === "ready") {
      if (inspected.filtered_items > 0) {
        this.log.warn("plan_items_filtered", { count: inspected.filtered_items });
      }
      this.onReady({ plan: inspected.turn.plan, source: "senpai", speech: inspected.turn.speech });
      return speechStream(inspected.turn.speech);
    }

    if (inspected.kind === "fallback") {
      const plan = buildTemplatePlan({
        facts: inspected.facts,
        today: this.context.today,
        locale: this.context.locale,
      });
      const speech =
        this.context.locale === "en"
          ? "Okay, I've made this light enough to start. If it slips, we'll redo it."
          : "オッケー、まず動ける軽さで組んだよ。崩れたらまた組み直そ。";
      // On screen it is the same plan. The degradation is recorded only in ops logs
      // and in source.
      this.log.warn("plan_template_fallback", { reason: inspected.reason, days: plan.days.length });
      this.onReady({ plan, source: "template", speech });
      return speechStream(speech);
    }

    // If the scope itself is broken, do not even fall back to the template. Asking
    // once, briefly, is safer than silently narrowing the facts we heard.
    this.log.warn("plan_regeneration_exhausted", { reason: inspected.reason });
    return speechStream(
      this.context.locale === "en"
        ? "Sorry — what part of the book is on the test?"
        : "ごめん、テスト範囲、教科書だとどのへん?",
    );
  }
}

function speechStream(text: string): ReadableStream<ChatChunk | string | FlushSentinel> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

function knownFacts(context: PlanSessionContext): string {
  if (context.current_plan === null) return context.locale === "en" ? "(none)" : "(なし)";
  return JSON.stringify(context.current_plan.intake, null, 2);
}

function currentPlan(context: PlanSessionContext): string {
  if (context.current_plan === null) return context.locale === "en" ? "(none)" : "(なし)";
  return JSON.stringify(context.current_plan, null, 2);
}
