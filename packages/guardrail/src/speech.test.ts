import { describe, expect, it } from "vitest";
import { normalizeEnglishGrammarSpeech } from "./english-grammar-speech.ts";
import { normalizeSpeech, normalizeUserUtterances } from "./speech.ts";

const grammar = (input: string) => normalizeEnglishGrammarSpeech(input).text;

describe("normalizeEnglishGrammarSpeech", () => {
  it("文型の読み上げを英字に戻す", () => {
    expect(grammar("ここはエスブイオーシーです")).toBe("ここはSVOCです");
    expect(grammar("エス ブイ オー オー の文")).toBe("SVOO の文");
    expect(grammar("エス・ブイ・シー")).toBe("SVC");
    expect(grammar("エスブイの文")).toBe("SVの文");
  });

  it("用語に混ざる英字を戻す", () => {
    expect(grammar("トゥ不定詞の副詞的用法")).toBe("to不定詞の副詞的用法");
    expect(grammar("ザット節が名詞節になっています")).toBe("that節が名詞節になっています");
    expect(grammar("ビー動詞のあとなのでイング形です")).toBe("be動詞のあとなのでing形です");
  });

  it("「形」と「系」の取り違えを直す", () => {
    expect(grammar("ここは現在完了系です")).toBe("ここは現在完了形です");
    expect(grammar("過去進行系になっています")).toBe("過去進行形になっています");
    expect(grammar("原型不定詞をとる動詞")).toBe("原形不定詞をとる動詞");
  });

  // カタカナで読み上げられた英文そのものは触らない。
  // 復元しようとすると誤りが増えるだけで、聞きたいのは音ではなく理由のほう。
  it("生徒が口にした英文は書き換えない", () => {
    const utterance = "アイ ハブ ビーン トゥ キョウト、と言いたかったです";
    expect(grammar(utterance)).toBe(utterance);
  });

  it("普通の日本語を壊さない", () => {
    const utterance = "そこは、なんとなくそう読めると思ったからです";
    expect(normalizeEnglishGrammarSpeech(utterance).applied).toEqual([]);
    expect(grammar(utterance)).toBe(utterance);
  });
});

describe("normalizeSpeech", () => {
  // 数式のルールを英文法に当てると、「かける」「にじょう」の置換が
  // 英語の説明に紛れ込む。科目でルールを切り替えていることを固定する。
  it("科目でルールが切り替わる", () => {
    expect(normalizeSpeech("エックスの2乗", "数学").text).toBe("x^2");
    expect(normalizeSpeech("エックスの2乗", "英文法").text).toBe("エックスの2乗");

    expect(normalizeSpeech("ここはエスブイオーシーです", "英文法").text).toBe("ここはSVOCです");
    expect(normalizeSpeech("ここはエスブイオーシーです", "数学").text).toBe(
      "ここはエスブイオーシーです",
    );
  });
});

describe("normalizeUserUtterances", () => {
  it("ユーザーの発話だけを正規化し、後輩の発話は触らない", () => {
    const messages = [
      { role: "assistant", text: "エックスの2乗の話ですよね?" },
      { role: "user", text: "はい、エックスの2乗です" },
    ];
    const normalized = normalizeUserUtterances(messages, "数学");
    expect(normalized[0]?.text).toBe("エックスの2乗の話ですよね?");
    expect(normalized[1]?.text).toBe("はい、x^2です");
  });

  it("英文法のセッションでは英文法のルールで正規化する", () => {
    const messages = [
      { role: "assistant", text: "なんでここでその形にしたんですか?" },
      { role: "user", text: "ビー動詞のあとだからイング形にしました" },
    ];
    const normalized = normalizeUserUtterances(messages, "英文法");
    expect(normalized[1]?.text).toBe("be動詞のあとだからing形にしました");
  });
});
