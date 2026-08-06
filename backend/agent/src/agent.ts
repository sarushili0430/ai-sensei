import type { CompleteSessionRequest } from "@ai-sensei/contract";
import { conversationSystemPrompt } from "@ai-sensei/prompts";
import { type JobContext, type JobProcess, defineAgent, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as silero from "@livekit/agents-plugin-silero";
import { closingGraceMs, isClosingUtterance } from "./closing.ts";
import { loadConfig } from "./config.ts";
import { type SessionContext, remainingSeconds, resolveSessionContext } from "./context.ts";
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
      // 参加者metadata(自動ディスパッチ)とジョブmetadata(明示ディスパッチ)の
      // どちらで来ても読めるようにする。
      context = resolveSessionContext([participant.metadata, ctx.job.metadata]);
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
      tts: new elevenlabs.TTS({
        apiKey: config.ELEVENLABS_API_KEY,
        voiceId: config.ELEVENLABS_VOICE_ID,
        modelID: config.ELEVENLABS_MODEL_ID,
        language: context.locale,
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

    const instructions = conversationSystemPrompt({
      photo_summary: context.photo_summary,
      visible_work: context.visible_work,
      allowed_topics: context.allowed_topics,
      question_seeds: context.question_seeds,
      remaining_seconds: context.max_seconds,
    });

    const agent = new voice.Agent({
      // プロンプト本体は日本語のまま。英語ロケールでは応答言語だけを切り替える
      // (審査員向けの英語対応。プロンプトの英訳はW4の磨き込みで行う)
      instructions:
        context.locale === "en"
          ? `${instructions}\n\n---\n\nRespond in English. Keep the same persona and the same rules.`
          : instructions,
    });

    await session.start({ agent, room: ctx.room });

    // 最初の一言は後輩から。ノートを見せてもらった側なので、確認から入る。
    session.say(greeting(context));

    // 上限秒数はサーバが決める。クライアントにもエージェントにも延ばさせない。
    const endedReason = await waitForEnd(session, context, startedAt, (handler) => {
      onClosing = handler;
    });

    // 会話はここで終わり。カルテ生成(数秒かかる)を待たせないよう、
    // 先に部屋を閉じる。開けたままだと上限時間を超えて話し続けられてしまう。
    const endedAt = new Date();
    await session.close().catch(() => undefined);

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
      const leaks = collector.answerLeaks.join(" / ");
      console.warn(
        `[guardrail] session=${context.session_id} 後輩が答えを漏らした可能性のある発話: ${leaks}`,
      );
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
    } catch (error) {
      console.error("[agent] /complete の送信に失敗しました", error);
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
