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

// 日本語は10〜20字の文が多い。12字なら短すぎる相槌を単独で読ませず、既定の20字より
// 早く最初の音を出せる。実測時はここを動かしてTTFBを比べる。
const minSentenceLength = 12;

// 読点ごとに切るとTTSがぶつ切りになる。24字あれば一息の節として十分長く、句点を待つ
// より早く話し始める価値がある。こちらも会話ログのTTFBで調整する。
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
 * `BufferedSentenceStream` は終了位置を使って未送信の入力を取り除くため、
 * SDKのbasic/sentence.jsと同じ `[token, start, end]` を返す。
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

/**
 * 日本語の句読点を読める文分割器。
 *
 * TTSベンダーには依存しない。いま当てているのは Gemini TTS を包む `StreamAdapter`
 * (`voice-session.ts` の `createSenpaiTts`)で、**分割された1文がそのまま1リクエスト**
 * になるため、ここの切り方がそのまま最初の音までの待ちになる。
 */
export class JapaneseSentenceTokenizer extends tokenize.SentenceTokenizer {
  tokenize(text: string, _language?: string): string[] {
    return splitJapaneseSentences(text).map(([token]) => token);
  }

  stream(_language?: string): tokenize.SentenceStream {
    // SDKが公開しているBufferedSentenceStreamを使うことで、flush/endInput/closeの
    // 振る舞いは既定分割器と一致する。1字ごとに再評価し、LLMのchunkサイズ由来の
    // 余計な待ちを入れない。
    return new tokenize.BufferedSentenceStream(splitJapaneseSentences, minSentenceLength, 1);
  }
}
