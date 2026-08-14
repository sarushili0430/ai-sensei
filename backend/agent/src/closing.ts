/**
 * Detects that a conversation ended naturally.
 *
 * The conversation prompt says to end with "今日はここまでにしよっか" or
 * "Let's stop here for today". Seeing that closing utterance closes the session
 * as `completed`.
 *
 * Without it, even a well-finished conversation idles until the cap (5 minutes
 * at most) and ended_reason never becomes `completed`.
 *
 * Like `handsTurnToStudent` in `senpai.ts`, the wording patterns are
 * structurally fragile: change the prompt and they silently fall out of sync.
 * A future option is having the LLM call an `end_session` tool, but that is not
 * implemented yet so the effect of the wording match can be isolated.
 */

/**
 * Confirms that "this far" means the whole of today's lesson.
 *
 * From review: "ここまで" also marks the end of an explanation. Mistaking
 * "説明はここまでかな?じゃあ次は" for a close shuts the room mid-lesson - worse
 * than not detecting it at all. Requiring a preceding word that scopes the whole
 * day ("今日は", "そろそろ") separates the two.
 *
 * A miss the other way ("じゃあここまでにしよっか") only idles until the cap, so
 * this errs toward missing. The prompt explicitly says to use
 * "今日はここまでにしよっか" (see "締め方" in `prompts/senpai_conversation.ja.md`),
 * and this matches that form.
 *
 * It must not span a full stop, so "今日" from a previous sentence cannot serve
 * as the scope ("今日は二次関数やったね。説明はここまでかな?" is not a close).
 */
const SESSION_SCOPE = String.raw`(?:今日|きょう|本日|そろそろ)[^。！!?？\n]{0,8}`;

/** Trailing anchor so words are not cut mid-token ("ここまでかなり進んだね" is not a close). */
const SENTENCE_TAIL = String.raw`(?:[。、！!?？,]|\s|$)`;

const CLOSING_PATTERNS: RegExp[] = [
  // The terminal form alone rules out "今日はここまでいい?", so no trailing anchor.
  new RegExp(`${SESSION_SCOPE}ここまでにし(?:よ(?:う|っか)|とこ(?:う|っか))`),
  new RegExp(`${SESSION_SCOPE}ここまでかな${SENTENCE_TAIL}`),
  new RegExp(
    String.raw`(?:また\s*)?(?:来たとき|今度)[、,]?\s*この続きやろ(?:う|っか)${SENTENCE_TAIL}`,
  ),
  /let['’]s stop here for today\b/i,
  /next time you['’]re here, let['’]s pick this up\b/i,
];

/** Whether this is the AI's closing utterance. Never used on user speech. */
export function isClosingUtterance(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  return CLOSING_PATTERNS.some((pattern) => pattern.test(normalized));
}
