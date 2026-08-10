import type { TranscriptMessage } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { buildAllowedTopics, normalizeMathSpeech } from "@ai-sensei/guardrail";
import { formatTranscript } from "@ai-sensei/prompts";
import type { SessionContext } from "./context.ts";

/**
 * 会話ログの収集。
 *
 * transcriptがそのままカルテの材料になる(handoff §5 データ設計)。
 * ユーザーの発話には数式音声の正規化をかけてから積む。
 *
 * **答えの漏れは、もう見ていない。**`containsAnswerLeak()` は
 * 改正前の約束1「答えを教えない」を守るための検知で、
 * 教える先輩には当たらない(ピボット計画 v1 §0 の改正・§8 の「捨てる」列)。
 * 当てたままにすると、**先輩が詰まった箇所を教えるたびに漏れとして記録され**、
 * 警告が鳴りっぱなしになる — 本物の異常を見落とす方向にしか働かない。
 *
 * 改正後に残っている約束は「**先に答えを埋めない**(まず言わせてから教える)」だが、
 * これは1発話の字面では判定できない。**同じ文が、生徒が説明したあとなら正しく、
 * 説明する前なら違反になる**。ターンの順序を見る必要があるので、
 * 正規表現のガードレールでは原理的に置き換えられない。守っているのは
 * `prompts/senpai_conversation.<locale>.md` の約束1で、コード側の相手はいない
 * (`prompts/README.md` の「二重書きの相手」表に**無しと明記してある**)。
 */
export class TranscriptCollector {
  private readonly messages: TranscriptMessage[] = [];

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
 * ロール名(先輩 / Senpai)はプロンプト側と揃える必要があるので、
 * @ai-sensei/prompts の整形をそのまま使う。
 */
export function renderTranscript(
  messages: readonly TranscriptMessage[],
  locale: CurriculumLocale = "ja",
): string {
  return formatTranscript(messages, locale);
}
