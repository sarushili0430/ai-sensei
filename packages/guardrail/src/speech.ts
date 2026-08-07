import type { Subject } from "@ai-sensei/curriculum";
import { normalizeEnglishGrammarSpeech } from "./english-grammar-speech.ts";
import { type NormalizationResult, normalizeMathSpeech } from "./math-speech.ts";

/**
 * 音声の正規化の入口。**科目でルールを切り替える。**
 *
 * 数式のルールを英文法のセッションに当てると、「かける」「わる」や
 * 「にじょう」の置換が英語の説明に紛れ込む。逆も同じ。
 * セッションの科目はサーバが決めてmetadataで渡すので、ここでは受け取るだけ。
 */
const normalizers: Record<Subject, (input: string) => NormalizationResult> = {
  数学: normalizeMathSpeech,
  英文法: normalizeEnglishGrammarSpeech,
};

export function normalizeSpeech(input: string, subject: Subject): NormalizationResult {
  return normalizers[subject](input);
}

/**
 * transcriptの各発話に正規化をかける。カルテ生成へ渡す前段で使う。
 * 後輩(assistant)の発話はTTS向けの整形済みテキストなので触らない。
 */
export function normalizeUserUtterances<T extends { role: string; text: string }>(
  messages: readonly T[],
  subject: Subject,
): T[] {
  return messages.map((message) =>
    message.role === "user"
      ? { ...message, text: normalizeSpeech(message.text, subject).text }
      : message,
  );
}
