import type { CurriculumLocale } from "@ai-sensei/curriculum";

/**
 * 数式音声の正規化(handoff §4(d))。
 *
 * 日本語STTは数式をそのまま文字にするので、「エックスのにじょう」「さんぶんのに」
 * のような発話が返る。ここで機械的に直せるぶんだけ直し、文脈依存の補正
 * (「この問題の説明中なら、この発話はx²のこと」)は写真文脈を持つLLM側に任せる。
 *
 * 英語STTも同じことが起きる("x squared" "square root of three")。
 * **ルールは言語ごとに分ける。** 日本語の規則を英語に当てても何も起きないが、
 * 逆は起きる(`\bpi\b` を日本語のローマ字混じり文に当てるなど)ので、
 * 言語を渡さない呼び出しは日本語の規則だけを使う。
 *
 * 方針: **やりすぎない**。誤変換を増やすくらいなら素通しする。
 * 変換は必ず `applied` に記録し、あとで効いているルールを検証できるようにする。
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
 * STTは「にじょう」「さんぶんのに」のように、数をかなのまま返すことがある。
 * ここで拾うのは1桁の読みだけ。2桁以上の読み(「じゅうに」等)は
 * 誤変換のリスクが上回るので、文脈を持つLLM側に任せる。
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

// かなの読みは長いものから並べる(「しち」を「し」で切らないため)
const KANA_NUM = "(?:いち|じゅう|きゅう|しち|さん|なな|よん|はち|ろく|に|し|ご|く)";
const NUM = `(?:[0-9０-９]+|[一二三四五六七八九十]+|${KANA_NUM})`;

/**
 * 適用順に意味がある。分数・累乗のように「まとまり」を作るものを先に処理し、
 * 単独記号の置換をあとに回す。
 */
export const rules: NormalizationRule[] = [
  // 「3分の2」「さんぶんのに」→ 2/3 (分母が先に来る日本語の語順を入れ替える)
  {
    name: "fraction",
    pattern: new RegExp(`(${NUM})\\s*(?:分の|ぶんの)\\s*(${NUM})`, "gu"),
    replacement: (_match, denominator: string, numerator: string) =>
      `${toDigits(numerator)}/${toDigits(denominator)}`,
  },
  // 「エックスの2乗」「xの二乗」→ x^2
  {
    name: "power-of",
    pattern: new RegExp(`(?:の)\\s*(${NUM})\\s*(?:乗|じょう)`, "gu"),
    replacement: (_match, exponent: string) => `^${toDigits(exponent)}`,
  },
  // 「2乗」単独 → ^2 (「の」を伴わない言い方)
  {
    name: "power-bare",
    pattern: new RegExp(`(?<=[a-zA-Zａ-ｚＡ-Ｚ0-9０-９)）])\\s*(${NUM})\\s*(?:乗|じょう)`, "gu"),
    replacement: (_match, exponent: string) => `^${toDigits(exponent)}`,
  },
  // 「ルート3」「るーと3」→ √3
  { name: "sqrt", pattern: /(?:ルート|るーと)\s*/gu, replacement: "√" },
  // 変数名。ひらがな/カタカナの読みだけを対象にし、漢字混じりの語は触らない
  { name: "var-x", pattern: /(?:エックス|えっくす)/gu, replacement: "x" },
  { name: "var-y", pattern: /(?:ワイ|わい)(?![がはをにでとやもの])/gu, replacement: "y" },
  { name: "var-z", pattern: /(?:ゼット|ぜっと)/gu, replacement: "z" },
  { name: "var-theta", pattern: /(?:シータ|しーた)/gu, replacement: "θ" },
  { name: "var-pi", pattern: /(?:パイ|ぱい)(?![おっ])/gu, replacement: "π" },
  // 三角比・対数
  { name: "sin", pattern: /(?:サイン|さいん)/gu, replacement: "sin" },
  { name: "cos", pattern: /(?:コサイン|こさいん)/gu, replacement: "cos" },
  { name: "tan", pattern: /(?:タンジェント|たんじぇんと)/gu, replacement: "tan" },
  { name: "log", pattern: /(?:ログ|ろぐ)(?![イいアあ])/gu, replacement: "log" },
  // 演算子・関係
  { name: "equal", pattern: /(?:イコール|いこーる)/gu, replacement: "=" },
  { name: "plus", pattern: /(?:プラス|ぷらす)/gu, replacement: "+" },
  { name: "minus", pattern: /(?:マイナス|まいなす)/gu, replacement: "-" },
  // 「かける」「わる」は日常語でもある(「時間をかける」)。
  // 数と数のあいだに挟まれているときだけ演算子とみなす。
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
  // 「かっこ」は式の読み上げでよく出るが、閉じ位置が曖昧なので触らない
];

/**
 * 英語STT向け。日本語ほど崩れないので、**確実なものだけ**を直す。
 *
 * `sine` → `sin` のような言い換えは入れていない。読みが正しく綴られていれば
 * LLMは読めるし、`tangent`(接線)を `tan` に潰すほうが害が大きい。
 */
/**
 * 英語の「式の一項」に見えるもの。`4x` `x^2` `2` `θ` `)` は項、`cost` は項ではない。
 *
 * ここを `[a-z]+` のように緩くすると、`cost plus tax` が `cost + tax` になる。
 * 演算子の語(plus / times / over)は日常語でもあるので、**両側が項のときだけ**
 * 記号にする。
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
  // ギリシャ文字を先に直す。演算子の判定は「両側が項か」で決めるので、
  // `theta plus pi` は θ・π にしてからでないと項として数えられない。
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
  // "3 over 4" → 3/4(数どうしのときだけ。"went over it" を割り算にしない)
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
  /** 適用されたルール名。テストとログで「効きすぎ」を監視する。 */
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
 * transcriptの各発話に正規化をかける。カルテ生成へ渡す前段で使う。
 * 後輩(assistant)の発話はTTS向けの整形済みテキストなので触らない。
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
