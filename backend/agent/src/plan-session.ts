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
import { leaveRoom } from "./room-exit.ts";
import { watchSessionEnd } from "./session-end.ts";
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
  // 計画も同じ会話基盤なので、開始前から同じ尺度で品質を比べられるようにする。
  const voiceMetrics = observeVoiceMetrics(session, log);

  const agent = new PlanVoiceAgent({
    context,
    startedAt,
    log,
    onReady: (next) => {
      // llmNodeがspeechだけを返す前にここへ来る。TTSが終わるまでは閉じず、
      // 下のAgentStateChangedで speaking を抜けた瞬間に完了させる。
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
      // 計画を画面へ出すcompleteは、最後の提案を読み終えてから送る。
      // llmNode直後に閉じるとJSONの検証は通っても、生徒には最後の一言が聞こえない。
      if (state.ready !== null && event.oldState === "speaking" && event.newState !== "speaking") {
        settle("completed");
      }
    });
    // **エラー1件では降りない。**降りるのはSDKが見限って `Close` を出したときだけ
    // (理由は `session-end.ts`)。授業と同じ判断にしておかないと、
    // 「たまに途中で切れる」が計画のほうにだけ残る。
    watchSessionEnd({ session, finish: settle, log });
  });

  await session.start({ agent, room: ctx.room });
  log.info("plan_conversation_started", {
    locale: context.locale,
    has_current_plan: context.current_plan !== null,
    max_seconds: context.max_seconds,
  });

  // 初回は3問の1つ目、組み直しは崩れた事実だけを聞く。フォーム入力は1つも作らない。
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

  // **保存より先に部屋を出る**(`leaveRoom`)。`session.close()` は声を畳むだけで
  // 参加者としては残るので、残ったまま保存へ進むと、アプリはその間ずっと
  // 「先輩が出ていくのを待つ」まま止まる(`plan_controller.dart` の `finish`)。
  // 保存の結果はアプリが計画を読み直して拾う(そのためのポーリング)ので、
  // ここで待たせる理由が無い。
  await leaveRoom(ctx.room, log);

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
    // 事実が揃う前の離脱では、テスト日や本人の言葉をでっち上げて空の計画を保存しない。
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
 * 計画LLMのJSONをTTSへ流さず、`speech` だけを会話パイプラインへ戻すagent。
 * 生のJSONをそのまま返すと、先輩が括弧・topic_id・分数を全部読み上げ、
 * モバイルの字幕にも計画本体が混ざる。計画は画面に出し、声は短い問いかけだけにする。
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
          // 写真が無いので範囲を絞れない。**この段のトピックを全部貼る**。
          //
          // 到達目標は落とす(`formatTopicIndex`)。計画LLMの仕事は「範囲の
          // topic_id を選ぶ」ことだけで、目標は選択の材料にならない。
          // 実測: 日本の高校数学52件で 6,516字 → 2,503字(-61%)。
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
      // 壊れた出力と修正理由を同じ文脈に置く。理由だけ渡すと、モデルは何を直すのか
      // 分からず、聞き取った範囲のほうを書き換えて辻褄を合わせにいく。
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
      // 画面では同じ計画として出す。縮退した事実は運用ログとsourceにだけ残す。
      this.log.warn("plan_template_fallback", { reason: inspected.reason, days: plan.days.length });
      this.onReady({ plan, source: "template", speech });
      return speechStream(speech);
    }

    // 範囲そのものが壊れているときはテンプレにも落とさない。聞き取った事実を
    // 黙って狭めるより、短く一度だけ聞き直すほうが安全。
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
