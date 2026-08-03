import {
  type JobContext,
  type JobProcess,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as silero from "@livekit/agents-plugin-silero";
import { conversationSystemPrompt } from "@ai-sensei/prompts";
import type { CompleteSessionRequest } from "@ai-sensei/contract";
import { loadConfig } from "./config.ts";
import { readSessionContext, remainingSeconds, type SessionContext } from "./context.ts";
import { buildKarte, createAnthropicClient, emptyKarte, postComplete } from "./karte.ts";
import { TranscriptCollector } from "./transcript.ts";

/**
 * 後輩AIの会話パイプライン。
 *
 *   VAD → 日本語ストリーミングSTT → Claude(後輩ペルソナ) → ElevenLabs TTS
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

    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    let context: SessionContext;
    try {
      context = readSessionContext(participant.metadata);
    } catch (error) {
      // 文脈なしで喋らせると、写真と関係ない一般論を聞き始めてしまう。
      // それくらいなら黙って終える。
      console.error("[agent] セッション文脈を読めませんでした", error);
      await ctx.room.disconnect();
      return;
    }

    const collector = new TranscriptCollector(startedAt, context);

    const session = new voice.AgentSession({
      vad: ctx.proc.userData["vad"] as never,
      stt: new deepgram.STT({ model: "nova-2-general", language: "ja", interimResults: true }),
      llm: new anthropic.LLM({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.LLM_MODEL_CONVERSATION,
        // 素朴な疑問の文体を安定させたいので、振れ幅は小さめにする
        temperature: 0.6,
      }),
      tts: new elevenlabs.TTS({
        apiKey: config.ELEVENLABS_API_KEY,
        voiceId: config.ELEVENLABS_VOICE_ID,
        modelID: config.ELEVENLABS_MODEL_ID,
        language: context.locale,
      }),
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item;
      if (!("role" in item)) return;
      const role = item.role === "assistant" ? "assistant" : "user";
      collector.add({ role, text: textOf(item), at: new Date() });
    });

    const agent = new voice.Agent({
      instructions: conversationSystemPrompt({
        photo_summary: context.photo_summary,
        visible_work: context.visible_work,
        allowed_topics: context.allowed_topics,
        question_seeds: context.question_seeds,
        remaining_seconds: context.max_seconds,
      }),
    });

    await session.start({ agent, room: ctx.room });

    // 最初の一言は後輩から。ノートを見せてもらった側なので、確認から入る。
    session.say(
      context.kind === "review"
        ? "この前わからなかったところ、もう一度きいてもいいですか?"
        : "ノート見せてもらいますね。ここ、ちょっと聞いてもいいですか?",
    );

    // 上限秒数はサーバが決める。クライアントにもエージェントにも延ばさせない。
    const endedReason = await waitForEnd(session, context, startedAt);

    const transcript = collector.all;
    const karte = collector.hasUserSpeech
      ? await buildKarte({
          context,
          transcript,
          llm: createAnthropicClient({
            apiKey: config.ANTHROPIC_API_KEY,
            model: config.LLM_MODEL_KARTE,
          }),
        }).catch((error) => {
          console.error("[agent] カルテ生成に失敗しました", error);
          return emptyKarte();
        })
      : emptyKarte();

    if (collector.answerLeaks.length > 0) {
      // プロンプト調整の材料。会話中に差し止めることはできないので記録に残す。
      console.warn(
        `[guardrail] session=${context.session_id} 後輩が答えを漏らした可能性のある発話: ` +
          collector.answerLeaks.join(" / "),
      );
    }

    const body: CompleteSessionRequest = {
      transcript,
      karte,
      duration_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      ended_reason: endedReason,
    };

    try {
      await postComplete({
        apiBaseUrl: config.API_BASE_URL,
        internalToken: config.INTERNAL_API_TOKEN,
        sessionId: context.session_id,
        body,
      });
    } catch (error) {
      console.error("[agent] /complete の送信に失敗しました", error);
    }

    await session.close();
  },
});

type EndedReason = CompleteSessionRequest["ended_reason"];

/**
 * 上限時間・ユーザーの離脱・エラーのいずれかで終わるまで待つ。
 * どれで終わったかは ended_reason としてカルテ側の重み付けに使う。
 */
function waitForEnd(
  session: voice.AgentSession,
  context: SessionContext,
  startedAt: Date,
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
