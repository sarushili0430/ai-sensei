/**
 * Rewriting maths symbols before handing text to Japanese TTS.
 *
 * Not used for display or captions. It keeps the board's and conversation's
 * original text intact and only turns symbols TTS would mute or read in English
 * into something pronounceable in Japanese.
 */

const digitReadings = [
  "ゼロ",
  "いち",
  "に",
  "さん",
  "よん",
  "ご",
  "ろく",
  "なな",
  "はち",
  "きゅう",
];

function digitReading(value: number): string {
  return digitReadings[value] ?? String(value);
}

/** Turns only the non-negative integers common in maths into kana Japanese TTS reads directly. */
function toJapaneseNumber(value: string): string {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number >= 10_000) {
    return value
      .split("")
      .map((digit) => digitReading(Number(digit)))
      .join("");
  }
  if (number < 10) return digitReading(number);

  const thousands = Math.floor(number / 1_000);
  const hundreds = Math.floor((number % 1_000) / 100);
  const tens = Math.floor((number % 100) / 10);
  const ones = number % 10;
  const thousandsReading =
    thousands === 0
      ? ""
      : ([
          "",
          "せん",
          "にせん",
          "さんぜん",
          "よんせん",
          "ごせん",
          "ろくせん",
          "ななせん",
          "はっせん",
          "きゅうせん",
        ][thousands] ?? "");
  const hundredsReading =
    hundreds === 0
      ? ""
      : ([
          "",
          "ひゃく",
          "にひゃく",
          "さんびゃく",
          "よんひゃく",
          "ごひゃく",
          "ろっぴゃく",
          "ななひゃく",
          "はっぴゃく",
          "きゅうひゃく",
        ][hundreds] ?? "");
  const tensReading = tens === 0 ? "" : tens === 1 ? "じゅう" : `${digitReading(tens)}じゅう`;

  return `${thousandsReading}${hundredsReading}${tensReading}${
    ones === 0 ? "" : digitReading(ones)
  }`;
}

function spellUppercaseLabel(label: string): string {
  return label
    .split("")
    .map(
      (letter) =>
        ({
          A: "エー",
          B: "ビー",
          C: "シー",
          D: "ディー",
          E: "イー",
          F: "エフ",
          G: "ジー",
          H: "エイチ",
          I: "アイ",
          J: "ジェー",
          K: "ケー",
          L: "エル",
          M: "エム",
          N: "エヌ",
          O: "オー",
          P: "ピー",
          Q: "キュー",
          R: "アール",
          S: "エス",
          T: "ティー",
          U: "ユー",
          V: "ブイ",
          W: "ダブリュー",
          X: "エックス",
          Y: "ワイ",
          Z: "ゼット",
        })[letter] ?? letter,
    )
    .join("");
}

/** Lower-case maths variables are read with the same letter name as their upper-case form. */
function spellMathVariable(variable: string): string {
  return spellUppercaseLabel(variable.toUpperCase());
}

const superscriptDigits: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

function superscriptNumber(value: string): string {
  return [...value].map((digit) => superscriptDigits[digit] ?? digit).join("");
}

/**
 * Rewrites a formula into a string Japanese TTS can read.
 *
 * Grouped expressions are rewritten before their parts. Vertex names are replaced
 * one character at a time later, so `∠ABC` and `BD:DC` must be handled first or the
 * grouping is lost.
 */
export function toSpeakableJa(text: string): string {
  let speakable = text;

  // Before replacing vertex names character by character, read angles, triangles and ratios each as one maths expression.
  speakable = speakable.replace(
    /∠([A-Z]+)/gu,
    (_match, label: string) => `かく${spellUppercaseLabel(label)}`,
  );
  speakable = speakable.replace(
    /△([A-Z]+)/gu,
    (_match, label: string) => `さんかくけい${spellUppercaseLabel(label)}`,
  );
  speakable = speakable.replace(
    /([A-Z]+):([A-Z]+)/gu,
    (_match, left: string, right: string) =>
      `${spellUppercaseLabel(left)} たい ${spellUppercaseLabel(right)}`,
  );

  // Only single letters are read as maths variables. A preceding letter means it is
  // part of a word, so the tail of `try^2` is not taken as a variable. A radical
  // covers only a run of digits or a single letter (with any following power).
  // Bracketed expressions like `√(a+b)` are not parsed, and the radical sign is kept.
  speakable = speakable.replace(
    /(?<![A-Za-z])(√?)([A-Za-z])\^([0-9]+)/gu,
    (_match, root: string, variable: string, exponent: string) =>
      `${root ? "ルート" : ""}${spellMathVariable(variable)}の${toJapaneseNumber(exponent)}じょう`,
  );
  speakable = speakable.replace(
    /(?<![A-Za-z])(√?)([A-Za-z])([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/gu,
    (_match, root: string, variable: string, exponent: string) =>
      `${root ? "ルート" : ""}${spellMathVariable(variable)}の${toJapaneseNumber(
        superscriptNumber(exponent),
      )}じょう`,
  );
  speakable = speakable.replace(
    /√([0-9]+)/gu,
    (_match, radicand: string) => `ルート${toJapaneseNumber(radicand)}`,
  );
  speakable = speakable.replace(
    /√([A-Za-z])(?![A-Za-z⁰¹²³⁴⁵⁶⁷⁸⁹^])/gu,
    (_match, radicand: string) => `ルート${spellMathVariable(radicand)}`,
  );
  speakable = speakable.replace(
    /([0-9]+)\/([0-9]+)/gu,
    (_match, numerator: string, denominator: string) =>
      `${toJapaneseNumber(denominator)}ぶんの${toJapaneseNumber(numerator)}`,
  );
  speakable = speakable.replace(
    /([0-9]+)°/gu,
    (_match, degrees: string) => `${toJapaneseNumber(degrees)}ど`,
  );

  speakable = speakable
    .replaceAll("≦", "いか")
    .replaceAll("≤", "いか")
    .replaceAll("≧", "いじょう")
    .replaceAll("≥", "いじょう")
    .replaceAll("≠", "ノットイコール")
    .replaceAll("→", "だから")
    .replaceAll("⇒", "だから")
    .replaceAll("θ", "シータ")
    .replaceAll("π", "パイ")
    .replaceAll("=", "イコール")
    .replaceAll("+", "プラス")
    .replaceAll("-", "マイナス");

  // Once the compound expressions above are settled, read the remaining vertex names.
  // An honorific like "Aさん" is ordinary Japanese containing a letter, so it is not
  // treated as a standalone maths vertex name.
  speakable = speakable.replace(/(?<![A-Za-z])([A-Z]{2,})(?![A-Za-z])/gu, (_match, label: string) =>
    spellUppercaseLabel(label),
  );
  return speakable.replace(
    /(?<![A-Za-z])([A-Z])(?![A-Za-z]|さん|ちゃん|くん|君|氏)/gu,
    (_match, label: string) => spellUppercaseLabel(label),
  );
}
