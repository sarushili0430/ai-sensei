/**
 * Detecting where the student said "I don't understand".
 *
 * This app is looking for gaps in understanding, and a place where the student said
 * so themselves is the clearest evidence there is. But the holes are written by an
 * LLM, which sometimes drops them entirely - a short conversation, lots of hedging.
 * When dropped, the screen says "today you explained without stalling", answering
 * "no holes" to someone who said they did not understand several times.
 *
 * This is a pure function that picks up only what can be picked up mechanically.
 * It is not a replacement for the LLM but the catcher for when the LLM returns zero
 * (`backend/agent/src/karte.ts`).
 *
 * The policy is the same as math-speech: do not overreach.
 * Mistaking an affirmative like "わかった" or "わかりました" for "わからない" is worse
 * than missing one (it would record something they said well as a hole), so only
 * clearly negative forms are matched.
 */

/**
 * Forms in which a student states a gap in understanding.
 *
 * Not just "わからない" but other phrasings used with the same meaning. High-school
 * students actually say "なんとなく", "習ってない" and "忘れた" more often.
 */
export const uncertaintyPatterns: RegExp[] = [
  // わからない / わかんない / 分からん / わかりません
  /わ(?:か|かん|から)(?:り(?:ませ|ま)ん|ない|ん(?:ない)?|らない)/,
  /分(?:か|から)(?:り(?:ませ|ま)ん|ない|ん|らない)/,
  // 知らない / 知りません
  /知(?:ら|り)(?:ない|ません|ん)/,
  // 習ってない / やってない / 覚えてない / 忘れた
  /(?:習|なら)っ(?:て(?:ない|いない|ません)|とらん)/,
  /覚え(?:て(?:ない|いない|ません))/,
  /忘れ(?:た|ちゃった|ました)/,
  // 説明できない / 言えない / 説明の仕方がわからない
  /(?:説明|言葉に)(?:が)?でき(?:ない|ません)/,
  /(?:うまく)?言え(?:ない|ません)/,
  // なんとなく / たぶん / 自信ない - phrasings used when no reason comes out
  /なんとなく/,
  /自信(?:が)?(?:ない|ありません)/,
  /(?:どう|なんで|なぜ)(?:して)?(?:だ|な)(?:っけ|ろう)/,
  // English (the reviewer-facing locale)
  /\bi\s+(?:don'?t|do not)\s+(?:know|remember|get it)/i,
  /\bno\s+idea\b/i,
  /\bnot\s+sure\b/i,
  /\bcan'?t\s+explain\b/i,
];

/**
 * Forms that must not be read as "I don't understand".
 *
 * Substring matching would catch sentences where a negative form appears inside an
 * affirmative.
 *   - "わからないことがわかりました" - a realisation, not a report of a gap
 *   - "わからなくなかった" - a double negative
 * Adding more starts causing misses, so add only false positives actually observed.
 */
const NOT_UNCERTAIN: RegExp[] = [
  /わ(?:か|から)らな(?:い|かった)こと(?:が|は)?(?:わ(?:か|から)|分か)/,
  /わ(?:か|から)らなく(?:な)?かった/,
];

/** Whether one utterance reports "I don't understand". */
export function isUncertaintyUtterance(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  if (normalized.length === 0) return false;
  if (NOT_UNCERTAIN.some((pattern) => pattern.test(normalized))) return false;
  return uncertaintyPatterns.some((pattern) => pattern.test(normalized));
}

export type SpeechTurn = { role: "assistant" | "user"; text: string };

/**
 * Returns, in order, the user utterances that say "I don't understand".
 *
 * The agent's (assistant's) speech is ignored. "I don't get it, please teach me" is
 * its role, so including it would match every time.
 */
export function findUncertaintyUtterances(turns: readonly SpeechTurn[]): string[] {
  return turns
    .filter((turn) => turn.role === "user" && isUncertaintyUtterance(turn.text))
    .map((turn) => turn.text.trim());
}
