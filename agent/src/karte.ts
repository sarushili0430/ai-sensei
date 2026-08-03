import {
  karteDraftSchema,
  type CompleteSessionRequest,
  type KarteDraft,
  type TranscriptMessage,
} from "@ai-sensei/contract";
import { buildAllowedTopics, filterHoleTopicIds } from "@ai-sensei/guardrail";
import { karteSystemPrompt } from "@ai-sensei/prompts";
import type { SessionContext } from "./context.ts";
import { renderTranscript } from "./transcript.ts";

/**
 * セッション終了時に、transcript全体からカルテを作って workers/api へ送る。
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

/** LLMの出力からカルテを作り、ガードレールを通す。 */
export async function buildKarte({
  context,
  transcript,
  llm,
}: BuildKarteOptions): Promise<KarteDraft> {
  const system = karteSystemPrompt({
    photo_summary: context.photo_summary,
    allowed_topics: context.allowed_topics,
    transcript: renderTranscript(transcript),
    is_premium: String(context.is_premium),
  });

  const raw = await llm.complete({
    system,
    user: "この会話からカルテのJSONだけを返してください。",
    maxTokens: 1200,
  });

  const draft = karteDraftSchema.parse(extractJson(raw));
  return applyGuardrails(draft, context);
}

/**
 * カルテ側のガードレール。
 * 会話の許可リストを越えたタグと、Premium限定のあと追い質問を落とす。
 * サーバ側でも同じ照合をするが、送る前に落としておけば無駄な往復が減る。
 */
export function applyGuardrails(draft: KarteDraft, context: SessionContext): KarteDraft {
  const allowed = buildAllowedTopics(context.allowed_topic_ids, { prerequisiteDepth: 0 });
  const { accepted } = filterHoleTopicIds(draft.holes, allowed);

  return {
    said_well: draft.said_well,
    holes: accepted,
    term_notes: draft.term_notes,
    followup_question: context.is_premium ? (draft.followup_question ?? null) : null,
  };
}

/** 会話が成立しなかったときのカルテ。空のカルテは失敗ではない。 */
export function emptyKarte(): KarteDraft {
  return { said_well: [], holes: [], term_notes: [], followup_question: null };
}

export type PostCompleteOptions = {
  apiBaseUrl: string;
  internalToken: string;
  sessionId: string;
  body: CompleteSessionRequest;
  fetchImpl?: typeof fetch;
};

export async function postComplete({
  apiBaseUrl,
  internalToken,
  sessionId,
  body,
  fetchImpl = fetch,
}: PostCompleteOptions): Promise<void> {
  const response = await fetchImpl(`${apiBaseUrl}/v1/sessions/${sessionId}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`/complete が失敗しました: ${response.status} ${await response.text()}`);
  }
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLMの出力にJSONが見つかりません");
  return JSON.parse(candidate.slice(start, end + 1));
}

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
      });
      if (!response.ok) {
        throw new Error(`カルテ生成に失敗しました: ${response.status}`);
      }
      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
      return payload.content?.find((part) => part.type === "text")?.text ?? "";
    },
  };
}
