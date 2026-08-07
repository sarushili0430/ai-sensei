import type { NormalizationResult, NormalizationRule } from "./math-speech.ts";

/**
 * 英文法の説明で出る音声の正規化。
 *
 * 日本語STTは、生徒が口にする**文法用語のうち英字が混ざるもの**をカタカナのまま返す。
 * 「エスブイオーシー」「トゥ不定詞」「ザット節」「イング形」がそれで、
 * このままカルテに積むと、同じことを言っているのに別の語として残ってしまう。
 *
 * 方針は数式の正規化と同じで **やりすぎない**:
 *
 * - 直すのは、英文法の文脈でしか出てこない言い方だけ。
 * - 生徒が口にした**英文そのもの**(「アイ ハブ ビーン トゥ キョウト」)は
 *   触らない。カタカナから英文を復元するのは誤りを増やすほうが大きく、
 *   そもそもこのアプリが聞きたいのは英文の音ではなく**なぜそう読めるか**なので、
 *   写真文脈を持つLLM側に任せる。
 * - かな → 漢字の言い換え(「かんけいだいめいし」)も入れない。今のSTTはほぼ漢字で返し、
 *   入れると普通の日本語を壊す側のリスクだけが残る。
 */

/** 「エス ブイ オー」のように区切って読まれるので、間の空白と中黒を許す。 */
const SEP = "[\\s・]*";

/**
 * 適用順に意味がある。文型はSVOO/SVOCのような長いものを先に処理しないと、
 * SVOで切られて末尾が取り残される。
 */
export const englishGrammarRules: NormalizationRule[] = [
  // 文型。「エスブイオーシー」→ SVOC
  {
    name: "pattern-svoo",
    pattern: new RegExp(`エス${SEP}ブイ${SEP}オー${SEP}オー`, "gu"),
    replacement: "SVOO",
  },
  {
    name: "pattern-svoc",
    pattern: new RegExp(`エス${SEP}ブイ${SEP}オー${SEP}シー`, "gu"),
    replacement: "SVOC",
  },
  {
    name: "pattern-svo",
    pattern: new RegExp(`エス${SEP}ブイ${SEP}オー`, "gu"),
    replacement: "SVO",
  },
  {
    name: "pattern-svc",
    pattern: new RegExp(`エス${SEP}ブイ${SEP}シー`, "gu"),
    replacement: "SVC",
  },
  { name: "pattern-sv", pattern: new RegExp(`エス${SEP}ブイ`, "gu"), replacement: "SV" },
  // 用語に混ざる英字。「トゥ不定詞」→ to不定詞
  { name: "be-verb", pattern: /(?:ビー|びー)\s*(?:動詞|どうし)/gu, replacement: "be動詞" },
  {
    name: "to-infinitive",
    pattern: /(?:トゥー|トゥ|ツー|とぅー)\s*(?:不定詞|ふていし)/gu,
    replacement: "to不定詞",
  },
  { name: "that-clause", pattern: /(?:ザット|ざっと)\s*(?:節|せつ)/gu, replacement: "that節" },
  {
    name: "ing-form",
    pattern: /(?:アイエヌジー|イング|いんぐ)\s*(?:形|けい)/gu,
    replacement: "ing形",
  },
  { name: "ed-form", pattern: /(?:イーディー|いーでぃー)\s*(?:形|けい)/gu, replacement: "ed形" },
  // 同音の取り違え。「形」を「系」と書かれると、用語として検索も照合もできなくなる。
  {
    name: "kanryo-kei",
    pattern: /(現在完了|過去完了|未来完了|現在進行|過去進行|進行)系/gu,
    replacement: "$1形",
  },
  { name: "genkei-futeishi", pattern: /原型不定詞/gu, replacement: "原形不定詞" },
  { name: "doushi-no-genkei", pattern: /動詞の原型/gu, replacement: "動詞の原形" },
];

export function normalizeEnglishGrammarSpeech(input: string): NormalizationResult {
  let text = input.normalize("NFKC");
  const applied: string[] = [];

  for (const rule of englishGrammarRules) {
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
