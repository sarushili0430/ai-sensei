import type { CurriculumLocale } from "@ai-sensei/curriculum";

/**
 * Normalizing spoken maths.
 *
 * Japanese STT transcribes formulas literally, so it returns utterances like
 * "エックスのにじょう" or "さんぶんのに". Only what can be fixed mechanically is fixed
 * here; context-dependent correction ("during an explanation of this problem, this
 * utterance means x²") is left to the LLM, which has the photo's context.
 *
 * The same happens with English STT ("x squared", "square root of three").
 * Rules are split per language. Japanese rules applied to English do nothing, but
 * the reverse does (applying `\bpi\b` to Japanese text containing romaji, say), so
 * a call without a language uses the Japanese rules only.
 *
 * Policy: do not overreach. Passing text through beats adding mis-conversions.
 * Every conversion is recorded in `applied` so the effective rules can be verified
 * later.
 */

export type NormalizationRule = {
  name: string;
  pattern: RegExp;
  replacement: string | ((...args: string[]) => string);
};

const KANJI_DIGITS: Record<string, string> = {
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
  十: "10",
};

/**
 * STT sometimes returns numbers as kana, as in "にじょう" or "さんぶんのに".
 * Only single-digit readings are picked up here. For two digits and up ("じゅうに"
 * etc.) the mis-conversion risk outweighs the gain, so they are left to the LLM,
 * which has the context.
 */
const KANA_DIGITS: Record<string, string> = {
  いち: "1",
  に: "2",
  さん: "3",
  よん: "4",
  し: "4",
  ご: "5",
  ろく: "6",
  なな: "7",
  しち: "7",
  はち: "8",
  きゅう: "9",
  く: "9",
  じゅう: "10",
};

function toDigits(value: string): string {
  return KANJI_DIGITS[value] ?? KANA_DIGITS[value] ?? value;
}

// Kana readings are listed longest first (so "しち" is not cut at "し")
const KANA_NUM = "(?:いち|じゅう|きゅう|しち|さん|なな|よん|はち|ろく|に|し|ご|く)";
const NUM = `(?:[0-9０-９]+|[一二三四五六七八九十]+|${KANA_NUM})`;

/**
 * The order matters. Things that form a group (fractions, powers) are handled
 * first, and single-symbol substitutions come after.
 */
export const rules: NormalizationRule[] = [
  // "3分の2" / "さんぶんのに" -> 2/3 (swapping the Japanese order, where the denominator comes first)
  {
    name: "fraction",
    pattern: new RegExp(`(${NUM})\\s*(?:分の|ぶんの)\\s*(${NUM})`, "gu"),
    replacement: (_match, denominator: string, numerator: string) =>
      `${toDigits(numerator)}/${toDigits(denominator)}`,
  },
  // "エックスの2乗" / "xの二乗" -> x^2
  {
    name: "power-of",
    pattern: new RegExp(`(?:の)\\s*(${NUM})\\s*(?:乗|じょう)`, "gu"),
    replacement: (_match, exponent: string) => `^${toDigits(exponent)}`,
  },
  // A bare "2乗" -> ^2 (the form without "の")
  {
    name: "power-bare",
    pattern: new RegExp(`(?<=[a-zA-Zａ-ｚＡ-Ｚ0-9０-９)）])\\s*(${NUM})\\s*(?:乗|じょう)`, "gu"),
    replacement: (_match, exponent: string) => `^${toDigits(exponent)}`,
  },
  // "ルート3" / "るーと3" -> √3
  { name: "sqrt", pattern: /(?:ルート|るーと)\s*/gu, replacement: "√" },
  // Variable names. Only the hiragana/katakana readings are targeted; words containing kanji are untouched
  { name: "var-x", pattern: /(?:エックス|えっくす)/gu, replacement: "x" },
  { name: "var-y", pattern: /(?:ワイ|わい)(?![がはをにでとやもの])/gu, replacement: "y" },
  { name: "var-z", pattern: /(?:ゼット|ぜっと)/gu, replacement: "z" },
  { name: "var-theta", pattern: /(?:シータ|しーた)/gu, replacement: "θ" },
  { name: "var-pi", pattern: /(?:パイ|ぱい)(?![おっ])/gu, replacement: "π" },
  // Trigonometry and logarithms
  { name: "sin", pattern: /(?:サイン|さいん)/gu, replacement: "sin" },
  { name: "cos", pattern: /(?:コサイン|こさいん)/gu, replacement: "cos" },
  { name: "tan", pattern: /(?:タンジェント|たんじぇんと)/gu, replacement: "tan" },
  { name: "log", pattern: /(?:ログ|ろぐ)(?![イいアあ])/gu, replacement: "log" },
  // Operators and relations
  { name: "equal", pattern: /(?:イコール|いこーる)/gu, replacement: "=" },
  { name: "plus", pattern: /(?:プラス|ぷらす)/gu, replacement: "+" },
  { name: "minus", pattern: /(?:マイナス|まいなす)/gu, replacement: "-" },
  // "かける" and "わる" are everyday words too ("時間をかける").
  // They count as operators only when sandwiched between two numbers.
  {
    name: "times",
    pattern: /(?<=[0-9０-９a-zA-Zxyzθπ)）])\s*(?:かける|掛ける)\s*(?=[0-9０-９a-zA-Zxyzθπ(（])/gu,
    replacement: "×",
  },
  {
    name: "divide",
    pattern: /(?<=[0-9０-９a-zA-Zxyzθπ)）])\s*(?:わる|割る)\s*(?=[0-9０-９a-zA-Zxyzθπ(（])/gu,
    replacement: "÷",
  },
  { name: "greater", pattern: /(?:大なり|だいなり)/gu, replacement: ">" },
  { name: "less", pattern: /(?:小なり|しょうなり)/gu, replacement: "<" },
  // "かっこ" appears often when reading formulas aloud, but its closing position is ambiguous, so it is left alone
];

/**
 * For English STT. It garbles less than Japanese, so only sure things are fixed.
 *
 * Rewrites like `sine` -> `sin` are excluded. If the reading is spelled correctly
 * the LLM can read it, and flattening `tangent` (the line) to `tan` does more harm.
 */
/**
 * What looks like a term in an English expression. `4x`, `x^2`, `2`, `θ` and `)`
 * are terms; `cost` is not.
 *
 * Loosening this to something like `[a-z]+` would turn `cost plus tax` into
 * `cost + tax`. Operator words (plus / times / over) are everyday words too, so
 * they become symbols only when both sides are terms.
 */
const EN_TERM = "(?:\\)|\\]|[a-zθπ]?[0-9]+[a-zθπ]?|[a-zθπ])(?:\\^[0-9]+)?";

function enOperator(name: string, word: string, symbol: string): NormalizationRule {
  return {
    name,
    pattern: new RegExp(
      `(?<![a-z0-9])(${EN_TERM})\\s+${word}\\s+(?=-?${EN_TERM}(?![a-z0-9]))`,
      "giu",
    ),
    replacement: (_match, left: string) => `${left} ${symbol} `,
  };
}

export const enRules: NormalizationRule[] = [
  // Greek letters are fixed first. Operators are decided by "is each side a term",
  // so `theta plus pi` must become θ and π before they count as terms.
  { name: "en-theta", pattern: /\btheta\b/giu, replacement: "θ" },
  { name: "en-pi", pattern: /\bpi\b/giu, replacement: "π" },
  // "x squared" → x^2 / "x cubed" → x^3
  { name: "en-squared", pattern: /(?<=[a-z0-9θπ)\]])\s+squared\b/giu, replacement: "^2" },
  { name: "en-cubed", pattern: /(?<=[a-z0-9θπ)\]])\s+cubed\b/giu, replacement: "^3" },
  // "to the power of 4" → ^4
  {
    name: "en-power-of",
    pattern: /\s*to the power of\s*([0-9]+)\b/giu,
    replacement: (_match, exponent: string) => `^${exponent}`,
  },
  // "square root of 3" → √3
  { name: "en-sqrt", pattern: /\bsquare root of\s+/giu, replacement: "√" },
  // "3 over 4" -> 3/4 (numbers only; "went over it" must not become division)
  {
    name: "en-fraction",
    pattern: /\b([0-9]+)\s+over\s+([0-9]+)\b/giu,
    replacement: (_match, numerator: string, denominator: string) => `${numerator}/${denominator}`,
  },
  enOperator("en-plus", "plus", "+"),
  enOperator("en-minus", "minus", "-"),
  enOperator("en-times", "times", "×"),
  enOperator("en-divide", "divided by", "÷"),
  enOperator("en-equals", "equals", "="),
];

export const rulesByLocale: Record<CurriculumLocale, NormalizationRule[]> = {
  ja: rules,
  en: enRules,
};

export type NormalizationResult = {
  text: string;
  /** The names of the rules applied. Tests and logs watch for over-application. */
  applied: string[];
};

export function normalizeMathSpeech(
  input: string,
  locale: CurriculumLocale = "ja",
): NormalizationResult {
  let text = input.normalize("NFKC");
  const applied: string[] = [];

  for (const rule of rulesByLocale[locale]) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    text = text.replace(
      pattern,
      rule.replacement as string & ((substring: string, ...args: unknown[]) => string),
    );
    applied.push(rule.name);
  }

  return { text, applied };
}

/**
 * Applies normalization to each transcript utterance. Used just before handing it
 * to karte generation.
 * The agent's (assistant's) speech is already formatted for TTS and is left alone.
 */
export function normalizeUserUtterances<T extends { role: string; text: string }>(
  messages: readonly T[],
  locale: CurriculumLocale = "ja",
): T[] {
  return messages.map((message) =>
    message.role === "user"
      ? { ...message, text: normalizeMathSpeech(message.text, locale).text }
      : message,
  );
}
