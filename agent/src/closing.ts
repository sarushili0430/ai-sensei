/**
 * 会話が自然に終わったことの検出。
 *
 * 会話プロンプトは「最後は『ありがとうございました、助かりました』で終える」と
 * 指示している。その締めの発話を見て `completed` として閉じる。
 *
 * これがないと、うまく終わった会話でも上限時間(最長5分)まで部屋が空回りし、
 * ended_reason に `completed` が一度も立たない。
 */

const CLOSING_PATTERNS: RegExp[] = [
  /ありがとうございま(?:した|す)[。!、]?\s*(?:助かりました)?/,
  /助かりました/,
  /また(?:今度|明日)(?:きき|聞き|お願い)/,
  /(?:thanks|thank you)[,.!]?\s*(?:that helped|got it)?/i,
];

/** 後輩の締めの発話かどうか。ユーザー側の発話には使わない。 */
export function isClosingUtterance(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  return CLOSING_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * 締めたあと、TTSが最後まで読み上げるのを待つ余白。
 * ここを0にすると、後輩の「ありがとうございました」が途中で切れる。
 */
export const closingGraceMs = 2500;
