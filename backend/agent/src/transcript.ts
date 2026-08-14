import type { TranscriptMessage } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { buildAllowedTopics, normalizeMathSpeech } from "@ai-sensei/guardrail";
import { formatTranscript } from "@ai-sensei/prompts";
import type { SessionContext } from "./context.ts";

/**
 * Collects the conversation log.
 *
 * The transcript is the karte's raw material (data design). User speech is
 * normalized for spoken math before being appended.
 *
 * Answer leaks are no longer checked. `containsAnswerLeak()` enforced the
 * pre-revision promise 1 ("never give the answer") and does not apply to a
 * senpai who teaches (pivot plan v1 §0 revision, §8 "drop" column). Keeping it
 * on would log a leak every time the senpai explains the stuck point, leaving
 * the warning permanently on - which only makes real anomalies easier to miss.
 *
 * The promise that survives is "never fill the answer in first" (make them say
 * it, then teach), which cannot be judged from a single utterance's wording:
 * the same sentence is correct after the student explains and a violation
 * before. It needs turn order, so a regex guardrail cannot replace it. It is
 * upheld by promise 1 in `prompts/senpai_conversation.<locale>.md` with no code
 * counterpart (explicitly recorded as none in the double-write table in
 * `prompts/README.md`).
 */
export class TranscriptCollector {
  private readonly messages: TranscriptMessage[] = [];

  // Same reason as `log.ts` for avoiding parameter properties (ADR 0002 type stripping).
  private readonly startedAt: Date;
  private readonly context: SessionContext;

  constructor(startedAt: Date, context: SessionContext) {
    this.startedAt = startedAt;
    this.context = context;
  }

  add(input: { role: "assistant" | "user"; text: string; at?: Date; topicId?: string }): void {
    // Spoken-math fixes differ per language ("にじょう" / "squared").
    const locale = this.context.locale;
    const text = input.role === "user" ? normalizeMathSpeech(input.text, locale).text : input.text;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    const message: TranscriptMessage = {
      role: input.role,
      text: trimmed,
      at_ms: Math.max(0, (input.at ?? new Date()).getTime() - this.startedAt.getTime()),
    };
    if (input.topicId !== undefined) message.topic_id = input.topicId;
    this.messages.push(message);
  }

  get all(): TranscriptMessage[] {
    return [...this.messages];
  }

  /** Whether the user actually explained. No karte for a conversation they never spoke in. */
  get hasUserSpeech(): boolean {
    return this.messages.some((message) => message.role === "user");
  }

  get allowedTopics() {
    return buildAllowedTopics(this.context.allowed_topic_ids, { prerequisiteDepth: 0 });
  }
}

/**
 * Render for pasting into the karte prompt.
 * Role names (先輩 / Senpai) must match the prompt side, so reuse the formatting
 * from @ai-sensei/prompts as-is.
 */
export function renderTranscript(
  messages: readonly TranscriptMessage[],
  locale: CurriculumLocale = "ja",
): string {
  return formatTranscript(messages, locale);
}
