import type { TranscriptMessage } from "@ai-sensei/contract";
import { buildAllowedTopics, containsAnswerLeak, normalizeMathSpeech } from "@ai-sensei/guardrail";
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

  constructor(
    private readonly startedAt: Date,
    private readonly context: SessionContext,
  ) {}

  add(input: { role: "assistant" | "user"; text: string; at?: Date; topicId?: string }): void {
    const text = input.role === "user" ? normalizeMathSpeech(input.text).text : input.text;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // 後輩が答えを漏らしていないかを見る。realtimeなので発話を差し止めることは
    // できないが、記録してプロンプト調整の材料にする(W2の調整で使う)。
    if (input.role === "assistant" && containsAnswerLeak(trimmed)) {
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

/** カルテ生成プロンプトに貼る形へ。 */
export function renderTranscript(messages: readonly TranscriptMessage[]): string {
  if (messages.length === 0) return "(発話なし)";
  return messages
    .map((message) => `${message.role === "assistant" ? "後輩" : "ユーザー"}: ${message.text}`)
    .join("\n");
}
