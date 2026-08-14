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
 * Builds the karte from the whole transcript at session end and posts it to
 * backend/api. It does not depend on LiveKit, so it can be unit tested.
 */

export type LlmClient = {
  complete(input: { system: string; user: string; maxTokens: number }): Promise<string>;
};

export type BuildKarteOptions = {
  context: SessionContext;
  transcript: readonly TranscriptMessage[];
  llm: LlmClient;
};

/** The karte instruction, in the system prompt's language; mixing them makes the output language wobble. */
const karteInstruction: Record<"ja" | "en", string> = {
  ja: "この会話からカルテのJSONだけを返してください。",
  en: "Return only the karte JSON for this conversation.",
};

/** Builds the karte from the LLM's output and runs it through the guardrails. */
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
 * The karte's guardrails.
 *
 * They correct tags outside the conversation's allow list and drop the
 * Premium-only follow-up question. The server matches the same way, but fixing it
 * before sending saves a round trip.
 *
 * Gaps themselves are never discarded. Gaps whose tag fell outside the allow list
 * used to be dropped whole, but what failed was the ID the LLM attached, not the
 * fact that the student said they did not understand. Discarding it leaves the
 * karte with nothing and the screen reports "you explained it without stopping
 * today". The tag is reassigned to the session's primary topic instead (the
 * conversation was about that topic, so the review notification is not off the
 * mark either).
 */
export function applyGuardrails(draft: KarteDraft, context: SessionContext): KarteDraft {
  const allowed = buildAllowedTopics(context.allowed_topic_ids, { prerequisiteDepth: 0 });
  const { rejected } = filterHoleTopicIds(draft.holes, allowed);
  const misTagged = new Set(rejected.map((entry) => entry.hole));
  const fallbackTopicId = primaryTopicId(context);

  const holes = draft.holes
    .map((hole) => {
      if (!misTagged.has(hole)) return hole;
      // A session with nothing to reassign to could not have started a
      // conversation at all; if one arrives anyway it is dropped, which beats
      // keeping an irrelevant ID.
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

/** The session's primary topic; where a gap's tag is reassigned. */
function primaryTopicId(context: SessionContext): string | undefined {
  return context.allowed_topic_ids[0];
}

/**
 * Stops a karte with zero gaps going out when the student said they did not
 * understand.
 *
 * The LLM writes the gaps, so it sometimes returns none because the conversation
 * was short or full of hesitation. But a spot where the student actually said "I
 * don't understand" is the clearest possible evidence of a gap, and dropping it
 * to reply "you explained it without stopping today" is the worst lie this app
 * can tell.
 *
 * It adds exactly one gap, grounded in the student's own words. If the LLM
 * already wrote gaps it does nothing — the count is never padded.
 */
export function withUncertaintyHole(
  karte: KarteDraft,
  context: SessionContext,
  transcript: readonly TranscriptMessage[],
): KarteDraft {
  if (karte.holes.length > 0) return karte;

  const said = findUncertaintyUtterances(transcript);
  if (said.length === 0) return karte;

  const topicId = primaryTopicId(context);
  if (topicId === undefined) return karte;

  return {
    ...karte,
    holes: [
      {
        topic_id: topicId,
        desc: uncertaintyDesc(topicId, context.locale),
        // The more often it was said, the more it matters next time; once may be
        // just hesitation.
        severity: said.length >= 2 ? "high" : "medium",
        // The evidence is their own words verbatim; summarised, it becomes "I
        // never said that".
        evidence: said.join(" / ").slice(0, 500),
      },
    ],
  };
}

/** Written without asserting: "the explanation stopped", not "they don't understand". */
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

/** The karte when no conversation happened. An empty karte is not a failure. */
export function emptyKarte(): KarteDraft {
  return { said_well: [], holes: [], term_notes: [], followup_question: null };
}

/**
 * Timeout for one `/complete` call.
 *
 * Holding a connection that never answers ends the job without even reaching a
 * retry, and from the app it looks like the karte simply never arrives.
 */
export const postCompleteTimeoutMs = 15_000;

export type PostCompleteOptions = {
  apiBaseUrl: string;
  internalToken: string;
  sessionId: string;
  body: CompleteSessionRequest;
  fetchImpl?: typeof fetch;
  /** Retry count. With one attempt, a momentary failure hides the karte forever. */
  attempts?: number;
  /** Backoff delay; tests set it to 0. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Posts the karte to the API.
 *
 * Without this succeeding, the karte does not exist even though the conversation
 * did. The app only polls `/result`, so a failed send looks like nothing more
 * than "no karte". `/complete` is idempotent (an existing one is returned), so a
 * failure is retried.
 *
 * 4xx responses (a token mismatch, a contract violation) do not improve on retry,
 * so they give up immediately.
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
      // 4xx was thrown above; do not retry.
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
 * Timeout for the LLM call that writes the karte.
 *
 * Stalling here means `/complete` is never sent even though the conversation is
 * over. The app keeps getting 202 from `/result` and appears stuck on
 * "fetching…". Giving up and posting an empty karte is far better than making
 * them wait (the caller catches and falls back to an empty karte).
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
