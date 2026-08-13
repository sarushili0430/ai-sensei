/**
 * 会話が自然に終わったことの検出。
 *
 * 会話プロンプトは「今日はここまでにしよっか」または
 * "Let's stop here for today" で終えると指示している。その締めの発話を見て
 * `completed` として閉じる。
 *
 * これがないと、うまく終わった会話でも上限時間(最長5分)まで部屋が空回りし、
 * ended_reason に `completed` が一度も立たない。
 *
 * 文言パターンは `senpai.ts` の `handsTurnToStudent` と同じく、プロンプト変更時に
 * 同期漏れを起こす構造的な脆さを持つ。将来は `end_session` のようなツールを
 * LLM に呼ばせる案があるが、文言合わせの効果を切り分けるため今回は実装しない。
 */

const CLOSING_PATTERNS: RegExp[] = [
  // 終止の形だけで「ここまでいい?」を除外できるため、後続アンカーは置かない。
  /ここまでにし(?:よ(?:う|っか)|とこ(?:う|っか))/,
  /ここまでかな(?:[。！!?]|\s|$)/,
  /(?:また\s*)?(?:来たとき|今度)[、,]?\s*この続きやろ(?:う|っか)(?:[。！!?]|\s|$)/,
  /let['’]s stop here for today\b/i,
  /next time you['’]re here, let['’]s pick this up\b/i,
];

/** AI側の締めの発話かどうか。ユーザー側の発話には使わない。 */
export function isClosingUtterance(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  return CLOSING_PATTERNS.some((pattern) => pattern.test(normalized));
}
