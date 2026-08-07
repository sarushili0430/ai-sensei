import type { CompleteSessionRequest } from "@ai-sensei/contract";
import { conversationSystemPrompt } from "@ai-sensei/prompts";
import { type JobContext, type JobProcess, defineAgent, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as silero from "@livekit/agents-plugin-silero";
import { closingGraceMs, isClosingUtterance } from "./closing.ts";
import { loadConfig } from "./config.ts";
import { type SessionContext, remainingSeconds, resolveSessionContext } from "./context.ts";
import {
  buildKarte,
  createAnthropicClient,
  emptyKarte,
  postComplete,
  withUncertaintyHole,
} from "./karte.ts";
import { JobLogger } from "./log.ts";
import { TranscriptCollector } from "./transcript.ts";

/**
 * 後輩AIの会話パイプライン。
 *
 *   VAD → 日本語ストリーミングSTT → Claude(後輩ペルソナ) → TTS(声)
 *
 * WebRTCは書かない(LiveKit Agentsに乗る)。ここで書くのは、
 * 写真文脈の受け渡し・上限時間の打ち切り・カルテ生成の3つだけ。
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
    // 設定を疑う)。アプリからは「後輩が来ない」としか見えないので、必ず残す。
    log.info("job_started");

    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    let context: SessionContext;
    try {
      // 参加者metadata(自動ディスパッチ)とジョブmetadata(明示ディスパッチ)の
      // どちらで来ても読めるようにする。
      context = resolveSessionContext([participant.metadata, ctx.job.metadata]);
    } catch (error) {
      // 文脈なしで喋らせると、写真と関係ない一般論を聞き始めてしまう。
      // それくらいなら黙って終える。
      log.error("context_unreadable", error, { participant: participant.identity });
      await ctx.room.disconnect();
      return;
    }

    log = log.child({ session_id: context.session_id });

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
        // 素朴な疑問の文体を安定させたいので、振れ幅は小さめにする
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

    // 会話が自然に終わったことを、後輩の締めの発話で見る。
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

    // プロンプトは言語ごとに別本(`prompts/<id>.<locale>.md`)。
    // 日本語の本文に「英語で答えて」を足す作りだと、ペルソナも禁止事項も
    // 日本語のまま薄く言い直されるだけで、範囲外に滑りやすくなる。
    const agent = new voice.Agent({
      instructions: conversationSystemPrompt(
        {
          photo_summary: context.photo_summary,
          visible_work: context.visible_work,
          allowed_topics: context.allowed_topics,
          question_seeds: context.question_seeds,
          remaining_seconds: context.max_seconds,
        },
        context.locale,
      ),
    });

    await session.start({ agent, room: ctx.room });

    // 最初の一言は後輩から。ノートを見せてもらった側なので、確認から入る。
    session.say(greeting(context));
    log.info("conversation_started", {
      kind: context.kind,
      locale: context.locale,
      max_seconds: context.max_seconds,
      topics: context.allowed_topic_ids.length,
    });

    // 上限秒数はサーバが決める。クライアントにもエージェントにも延ばさせない。
    const endedReason = await waitForEnd(session, context, startedAt, (handler) => {
      onClosing = handler;
    });

    // 会話はここで終わり。カルテ生成(数秒かかる)を待たせないよう、
    // 先に部屋を閉じる。開けたままだと上限時間を超えて話し続けられてしまう。
    const endedAt = new Date();
    await session.close().catch(() => undefined);

    const transcript = collector.all;
    log.info("conversation_ended", {
      ended_reason: endedReason,
      duration_seconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
      turns: transcript.length,
      user_spoke: collector.hasUserSpeech,
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

    if (collector.answerLeaks.length > 0) {
      // プロンプト調整の材料。会話中に差し止めることはできないので記録に残す。
      log.warn("answer_leak_suspected", { utterances: collector.answerLeaks });
    }

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

function greeting(context: SessionContext): string {
  if (context.locale === "en") {
    return context.kind === "review"
      ? "Can I ask you again about the part we got stuck on?"
      : "Let me look at your notes. Can I ask you something?";
  }
  return context.kind === "review"
    ? "この前わからなかったところ、もう一度きいてもいいですか?"
    : "ノート見せてもらいますね。ここ、ちょっと聞いてもいいですか?";
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
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (reason: EndedReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(reason);
    };

    const timer = setTimeout(
      () => finish("timeout"),
      remainingSeconds(context, startedAt, new Date()) * 1000,
    );

    // 後輩が締めの言葉を言ったら、読み上げが終わる余白だけ待って閉じる
    registerClosing(() => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => finish("completed"), closingGraceMs);
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
