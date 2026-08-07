import type { TranscriptMessage } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { buildAllowedTopics, containsAnswerLeak, normalizeMathSpeech } from "@ai-sensei/guardrail";
import { formatTranscript } from "@ai-sensei/prompts";
import type { SessionContext } from "./context.ts";

/**
 * 会話ログの収集。
 *
 * transcriptがそのままカルテの材料になる(handoff §5 データ設計)。
 * ユーザーの発話には数式音声の正規化をかけてから積む。
 */
export class TranscriptCollector {
  private readonly messages: TranscriptMessage[] = [];
  private readonly leaks: string[] = [];

  // parameter property を使わない理由は `log.ts` と同じ(ADR 0002 の型ストリップ)。
  private readonly startedAt: Date;
  private readonly context: SessionContext;

  constructor(startedAt: Date, context: SessionContext) {
    this.startedAt = startedAt;
    this.context = context;
  }

  add(input: { role: "assistant" | "user"; text: string; at?: Date; topicId?: string }): void {
    // 数式音声の直し方は言語ごとに違う(「にじょう」/ "squared")。
    const locale = this.context.locale;
    const text = input.role === "user" ? normalizeMathSpeech(input.text, locale).text : input.text;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // 後輩が答えを漏らしていないかを見る。realtimeなので発話を差し止めることは
    // できないが、記録してプロンプト調整の材料にする(W2の調整で使う)。
    if (input.role === "assistant" && containsAnswerLeak(trimmed, locale)) {
      this.leaks.push(trimmed);
    }

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

  get answerLeaks(): string[] {
    return [...this.leaks];
  }

  /** ユーザーが実際に説明したか。1度も喋っていない会話ではカルテを作らない。 */
  get hasUserSpeech(): boolean {
    return this.messages.some((message) => message.role === "user");
  }

  get allowedTopics() {
    return buildAllowedTopics(this.context.allowed_topic_ids, { prerequisiteDepth: 0 });
  }
}

/**
 * カルテ生成プロンプトに貼る形へ。
 * ロール名(後輩 / Kohai)はプロンプト側と揃える必要があるので、
 * @ai-sensei/prompts の整形をそのまま使う。
 */
export function renderTranscript(
  messages: readonly TranscriptMessage[],
  locale: CurriculumLocale = "ja",
): string {
  return formatTranscript(messages, locale);
}
