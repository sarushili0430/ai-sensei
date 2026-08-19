import {
  type CompleteSessionRequest,
  type HoleDraft,
  type KarteDraft,
  type TranscriptMessage,
  karteDraftSchema,
} from "@ai-sensei/contract";
import { findTopic } from "@ai-sensei/curriculum";
import {
  buildAllowedTopics,
  filterHoleTopicIds,
  findUncertaintyUtterances,
} from "@ai-sensei/guardrail";
import { karteSystemPrompt } from "@ai-sensei/prompts";
import { type SessionContext, subjectOf } from "./context.ts";
import { renderTranscript } from "./transcript.ts";

/**
 * セッション終了時に、transcript全体からカルテを作って backend/api へ送る。
 * ここはLiveKitに依存しないので、単体でテストできる。
 */

export type LlmClient = {
  complete(input: { system: string; user: string; maxTokens: number }): Promise<string>;
};

export type BuildKarteOptions = {
  context: SessionContext;
  transcript: readonly TranscriptMessage[];
  llm: LlmClient;
};

/** カルテ生成の指示。systemと同じ言語で頼む(混ぜると出力の言語が揺れる)。 */
const karteInstruction: Record<"ja" | "en", string> = {
  ja: "この会話からカルテのJSONだけを返してください。",
  en: "Return only the karte JSON for this conversation.",
};

/** LLMの出力からカルテを作り、ガードレールを通す。 */
export async function buildKarte({
  context,
  transcript,
  llm,
}: BuildKarteOptions): Promise<KarteDraft> {
  const system = karteSystemPrompt(
    {
      photo_summary: context.photo_summary,
      allowed_topics: context.allowed_topics,
      transcript: renderTranscript(transcript, context.locale),
      is_premium: String(context.is_premium),
    },
    { locale: context.locale, subject: subjectOf(context) },
  );

  const raw = await llm.complete({
    system,
    user: karteInstruction[context.locale],
    maxTokens: 1200,
  });

  const draft = karteDraftSchema.parse(extractJson(raw));
  return applyGuardrails(draft, context);
}

/**
 * カルテ側のガードレール。
 * 会話の許可リストを越えたタグを直し、Premium限定のあと追い質問を落とす。
 * サーバ側でも同じ照合をするが、送る前に直しておけば無駄な往復が減る。
 *
 * **穴そのものは捨てない。** 以前はタグが許可リストから外れた穴を丸ごと
 * 落としていたが、落ちるのはLLMが付けたIDであって、本人が「わからない」と
 * 言った事実ではない。捨てるとカルテには何も残らず、画面には
 * 「今日は、止まらずに説明できました」と出てしまう。
 * タグはこのセッションの主単元に付け替える(会話はその単元の話だったので、
 * 復習の通知も的外れにはならない)。
 */
export function applyGuardrails(draft: KarteDraft, context: SessionContext): KarteDraft {
  const allowed = buildAllowedTopics(context.allowed_topic_ids, { prerequisiteDepth: 0 });
  const { rejected } = filterHoleTopicIds(draft.holes, allowed);
  const misTagged = new Set(rejected.map((entry) => entry.hole));
  const fallbackTopicId = primaryTopicId(context);

  const holes = draft.holes
    .map((hole) => {
      if (!misTagged.has(hole)) return hole;
      // 付け替える先が無いセッションは、そもそも会話が始まらない。
      // それでも来たときだけは落とす(的外れなIDのまま残すよりまし)。
      if (fallbackTopicId === undefined) return undefined;
      return { ...hole, topic_id: fallbackTopicId };
    })
    .filter((hole): hole is HoleDraft => hole !== undefined);

  return {
    said_well: draft.said_well,
    holes,
    term_notes: draft.term_notes,
    followup_question: context.is_premium ? (draft.followup_question ?? null) : null,
  };
}

/** このセッションの主単元。穴のタグを付け替える先。 */
function primaryTopicId(context: SessionContext): string | undefined {
  return context.allowed_topic_ids[0];
}

/**
 * 「わからない」と言ったのに穴がゼロだったカルテを、そのまま出さない。
 *
 * 穴を書くのはLLMなので、会話が短かった・言い淀みが多かったという理由で
 * 穴を1件も返さないことがある。だが**本人が「わからない」と口にした箇所は、
 * 理解の穴のいちばんはっきりした証拠**で、それを落として
 * 「今日は、止まらずに説明できました」と返すのが、このアプリで一番わるい嘘になる。
 *
 * ここで足すのは、本人の発話をそのまま根拠にした1件だけ。
 * LLMが既に穴を書いているときは何もしない(数を水増ししない)。
 */
export function withUncertaintyHole(
  karte: KarteDraft,
  context: SessionContext,
  transcript: readonly TranscriptMessage[],
): KarteDraft {
  if (karte.holes.length > 0) return karte;

  const said = findUncertaintyUtterances(transcript);
  if (said.length === 0) return karte;

  /**
   * **会話中に問題を差し替えたセッションでは、この推測を打たない。**
   *
   * transcript は全部の問題ぶんが1本に並ぶのに、`allowed_topic_ids` は
   * **最後の問題のもの**しか持っていない(発話に単元の境界が無い)。
   * そのまま先頭のIDを付けると、1問目で言った「わからない」が2問目の単元の穴になり、
   * **本人が触れていない単元の復習**が1/3/7日後に届く。誤った単元へ連れて行くくらいなら、
   * ここは黙るほうがまだ直せる —— `/complete` が `review_outcome` を推測で立てないのと
   * 同じ判断。LLMが穴を書けていれば従来どおり通る(上の早期returnで抜けている)。
   */
  if ((context.context_revision ?? 1) > 1) return karte;

  const topicId = primaryTopicId(context);
  if (topicId === undefined) return karte;

  return {
    ...karte,
    holes: [
      {
        topic_id: topicId,
        desc: uncertaintyDesc(topicId, context.locale),
        // 何度も言っているほど、次に効く。1回だけなら言い淀みのこともある。
        severity: said.length >= 2 ? "high" : "medium",
        // 根拠は本人の言葉のまま。要約すると「そんなことは言っていない」になる。
        evidence: said.join(" / ").slice(0, 500),
      },
    ],
  };
}

/** 断定しない文体で書く。「理解していない」ではなく「説明が止まった」。 */
function uncertaintyDesc(topicId: string, locale: string): string {
  const topic = findTopic(topicId)?.topic;
  const desc =
    locale === "en"
      ? topic
        ? `Explaining ${topic} stalled at "I don't know"`
        : 'Your explanation stalled at "I don\'t know"'
      : topic
        ? `${topic}の説明が「わからない」で止まった`
        : "説明が「わからない」で止まった";
  return desc.slice(0, 200);
}

/** 会話が成立しなかったときのカルテ。空のカルテは失敗ではない。 */
export function emptyKarte(): KarteDraft {
  return { said_well: [], holes: [], term_notes: [], followup_question: null };
}

/**
 * `/complete` 1回ぶんの上限。
 *
 * 返事が来ない接続を掴んだままにすると、送り直しにも入れないまま
 * ジョブが終わる。アプリからは「カルテがいつまでも来ない」に見える。
 */
export const postCompleteTimeoutMs = 15_000;

export type PostCompleteOptions = {
  apiBaseUrl: string;
  internalToken: string;
  sessionId: string;
  body: CompleteSessionRequest;
  fetchImpl?: typeof fetch;
  /** 送り直す回数。1回きりだと、一瞬の失敗でカルテが永久に表に出ない。 */
  attempts?: number;
  /** 待ち時間(テストから0にする)。 */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * カルテをAPIへ送る。
 *
 * **ここが通らないと、会話が成立していてもカルテは存在しないことになる。**
 * アプリは `/result` を見に来るだけなので、送信の失敗は「カルテが出ない」
 * としか見えない。`/complete` は冪等(既にあれば保存済みを返す)なので、
 * 落ちたら送り直す。
 *
 * 4xx は送り直しても同じなので、すぐ諦める(トークンずれ・契約違反)。
 */
export async function postComplete({
  apiBaseUrl,
  internalToken,
  sessionId,
  body,
  fetchImpl = fetch,
  attempts = 3,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: PostCompleteOptions): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${apiBaseUrl}/v1/sessions/${sessionId}/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${internalToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(postCompleteTimeoutMs),
      });

      if (response.ok) return;

      const detail = await response.text().catch(() => "");
      const error = new Error(`/complete が失敗しました: ${response.status} ${detail}`);
      if (response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      // 4xx はここで throw されたもの。送り直さない。
      if (error instanceof Error && /失敗しました: 4/.test(error.message)) throw error;
      lastError = error;
    }

    if (attempt < attempts) await sleep(attempt * 1000);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLMの出力にJSONが見つかりません");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * カルテを書くLLM呼び出しの上限。
 *
 * ここで詰まると、会話は終わっているのに `/complete` が永久に送られない。
 * アプリ側は `/result` が202を返し続けるので、「取りに行っています…」の
 * まま固まったようにしか見えない。**待つのをやめて空のカルテで送る**ほうが、
 * 待たせ続けるよりずっとまし(呼び出し側が catch して空カルテに落とす)。
 */
export const karteTimeoutMs = 60_000;

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function createAnthropicClient(options: AnthropicOptions): LlmClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";

  return {
    async complete({ system, user, maxTokens }) {
      const response = await doFetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(karteTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`カルテ生成に失敗しました: ${response.status}`);
      }
      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
      return payload.content?.find((part) => part.type === "text")?.text ?? "";
    },
  };
}
