/**
 * 日本語TTSへ渡す前の、数式記号の読み替え。
 *
 * これは表示・字幕には使わない。板書や会話の原文を保ったまま、TTSが無音にしたり
 * 英語読みへ落としたりする記号だけを、日本語で発音できる形にする。
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

/** 数学で頻出する非負整数だけを、日本語TTSがそのまま読めるかなへ替える。 */
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

/** 小文字の数式変数も、対応する大文字と同じアルファベット名で読む。 */
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
 * 数式を日本語TTSが読める文字列へ替える。
 *
 * まとまりを持つ式を、部品より先に読む形へ替える。後で頂点名を一文字ずつ替えるため、
 * `∠ABC` や `BD:DC` を先に処理しないと、式のまとまりが失われる。
 */
export function toSpeakableJa(text: string): string {
  let speakable = text;

  // 頂点名を一文字ずつ替える前に、角・三角形・比をそれぞれ一つの数学表現として読む。
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

  // 1文字の英字だけを数式変数として読む。直前が英字なら単語の一部なので、`try^2`
  // の末尾などを変数として拾わない。根号は数字列・英字1文字(直後の累乗を含む)までしか
  // 読まない。`√(a+b)` のような括弧付きの式は構文解析せず、根号記号を残す。
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

  // 上の複合表現を確定してから、残った頂点名を読む。敬称つきの「Aさん」は英字を含む
  // 普通の日本語なので、数学の単独頂点名として扱わない。
  speakable = speakable.replace(/(?<![A-Za-z])([A-Z]{2,})(?![A-Za-z])/gu, (_match, label: string) =>
    spellUppercaseLabel(label),
  );
  return speakable.replace(
    /(?<![A-Za-z])([A-Z])(?![A-Za-z]|さん|ちゃん|くん|君|氏)/gu,
    (_match, label: string) => spellUppercaseLabel(label),
  );
}
