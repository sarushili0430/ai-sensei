import { tokenize } from "@livekit/agents";

type SentenceToken = [string, number, number];

const sentenceEndings = new Set(["。", "？", "！", ".", "?", "!"]);
const closingMarks = new Set([
  "」",
  "』",
  "）",
  "］",
  "｝",
  "】",
  "〕",
  "〉",
  "》",
  "”",
  "’",
  '"',
  "'",
]);

// Japanese sentences are mostly 10-20 chars. 12 avoids reading a too-short
// interjection alone and emits the first audio sooner than the default 20.
// When measuring, move this and compare TTFB.
const minSentenceLength = 12;

// Splitting at every comma makes TTS choppy. 24 chars is long enough for one
// breath group and worth starting to speak before the full stop. Also tuned from
// TTFB in conversation logs.
const longClauseLength = 24;

function isDecimalPoint(text: string, index: number): boolean {
  const previous = text[index - 1];
  const following = text[index + 1];
  return (
    previous !== undefined &&
    following !== undefined &&
    /[0-9]/.test(previous) &&
    /[0-9]/.test(following)
  );
}

function addToken(tokens: SentenceToken[], text: string, start: number, end: number): void {
  const token = text.slice(start, end).trim();
  if (token) tokens.push([token, start, end]);
}

/**
 * `BufferedSentenceStream` uses the end offset to drop unsent input, so return
 * `[token, start, end]` exactly like the SDK's basic/sentence.js.
 */
export function splitJapaneseSentences(text: string): SentenceToken[] {
  const tokens: SentenceToken[] = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === undefined) break;

    if (character === "、" && text.slice(start, index).trim().length >= longClauseLength) {
      addToken(tokens, text, start, index + 1);
      start = index + 1;
      index += 1;
      continue;
    }

    if (!sentenceEndings.has(character) || (character === "." && isDecimalPoint(text, index))) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < text.length) {
      const following = text[end];
      if (following !== undefined && sentenceEndings.has(following)) {
        end += 1;
        continue;
      }
      break;
    }
    while (end < text.length) {
      const following = text[end];
      if (following !== undefined && closingMarks.has(following)) {
        end += 1;
        continue;
      }
      break;
    }

    addToken(tokens, text, start, end);
    start = end;
    index = end;
  }

  addToken(tokens, text, start, text.length);
  return tokens;
}

/** A sentence splitter for Deepgram TTS that understands Japanese punctuation. */
export class JapaneseSentenceTokenizer extends tokenize.SentenceTokenizer {
  tokenize(text: string, _language?: string): string[] {
    return splitJapaneseSentences(text).map(([token]) => token);
  }

  stream(_language?: string): tokenize.SentenceStream {
    // Using the SDK's public BufferedSentenceStream keeps flush/endInput/close
    // behaviour identical to the default splitter. Re-evaluates per character so
    // the LLM's chunk size adds no extra wait.
    return new tokenize.BufferedSentenceStream(splitJapaneseSentences, minSentenceLength, 1);
  }
}
