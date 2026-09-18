import { describe, expect, it } from "vitest";
import type { LlmClient } from "../karte.ts";
import type { LessonTurn } from "../senpai.ts";
import { type EvalScenario, findScenario } from "./scenario.ts";
import {
  asSpokenLine,
  createLlmStudent,
  createScriptedStudent,
  isStudentPersona,
  studentContextTurns,
  studentPersonas,
  studentUtteranceMaxLength,
} from "./student.ts";

/**
 * 生徒シミュレータのテスト。**実ネットワークを使わない**(stub `LlmClient`)。
 *
 * 見たいのは3つ:
 *   1. 出力がSTT風の1行に畳まれること(名前の札・かぎ括弧・改行が落ちる)
 *   2. `silent` の無言が**決定的**なこと(初回は答え、以降は呼ばずに null)
 *   3. プロンプトがロケールの同言語で組まれ、ペルソナごとに別本になること
 */

const ja = findScenario("math_quadratic", "ja") as EvalScenario;
const en = findScenario("math_quadratic", "en") as EvalScenario;

/** 呼ばれた `{system, user}` を記録するstub。返す本文は呼び出し順。 */
function stubLlm(...outputs: readonly string[]): LlmClient & {
  calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  return {
    calls,
    complete({ system, user }) {
      calls.push({ system, user });
      return Promise.resolve(outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? "");
    },
  };
}

const turns: LessonTurn[] = [
  {
    kind: "step",
    step: {
      index: 0,
      speech: "まず、式をそのまま書くね。",
      board: { kind: "latex", tex: "x^2 = 4" },
    },
  },
  { kind: "step", step: { index: 1, speech: "この式、まず何する?", board: null } },
];

describe("asSpokenLine", () => {
  it("名前の札・かぎ括弧・改行を落として1行にする", () => {
    expect(asSpokenLine("生徒: 「えっと、\n因数分解?」")).toBe("えっと、 因数分解?");
    expect(asSpokenLine("  Student: um, maybe two  ")).toBe("um, maybe two");
  });

  it("空になったら null(無言と同じ扱い)", () => {
    expect(asSpokenLine("   ")).toBeNull();
    expect(asSpokenLine("「」")).toBeNull();
  });

  it("長すぎる答えは切る(次のパスの文脈を作文で埋めない)", () => {
    const long = "あ".repeat(studentUtteranceMaxLength + 50);
    expect(asSpokenLine(long)).toHaveLength(studentUtteranceMaxLength);
    // 先輩の発話はジャッジが読む一次資料なので、上限を広げて渡せる。
    expect(asSpokenLine(long, 600)).toHaveLength(studentUtteranceMaxLength + 50);
  });
});

describe("createScriptedStudent", () => {
  it("台本の順に答え、使い切ったら無言になる", async () => {
    const student = createScriptedStudent(["12だと思う", null]);
    await expect(student.answer(turns, "lesson")).resolves.toBe("12だと思う");
    await expect(student.answer(turns, "lesson")).resolves.toBeNull();
    await expect(student.answer(turns, "teach_back")).resolves.toBeNull();
    expect(student.asked.map((entry) => entry.phase)).toEqual(["lesson", "lesson", "teach_back"]);
    expect(student.persona).toBe("scripted");
  });
});

describe("createLlmStudent", () => {
  it("STT風に畳んだ発話を返し、直近の手順を渡す", async () => {
    const llm = stubLlm("生徒: 「えっと、因数分解?」");
    const student = createLlmStudent({ llm, persona: "cooperative", locale: "ja", scenario: ja });

    await expect(student.answer(turns, "lesson")).resolves.toBe("えっと、因数分解?");
    expect(student.persona).toBe("cooperative");

    const [call] = llm.calls;
    // 直前の問いかけが入っている(ここが落ちると、生徒は何を聞かれたか分からない)
    expect(call?.user).toContain("この式、まず何する?");
    expect(call?.user).toContain("先輩の直前の問いかけ");
    // 問題文とノートの読み取りは板書プロンプトと同じ値を貼る
    expect(call?.system).toContain("x^2 - 5x + 6 = 0");
    expect(call?.system).toContain("(x - 2)(x - 3) = 0");
  });

  it("教え返しでは説明を頼む(同じ生徒・違う指示)", async () => {
    const llm = stubLlm("かけて6になる2つを探した");
    const student = createLlmStudent({ llm, persona: "cooperative", locale: "ja", scenario: ja });

    await expect(student.answer(turns, "teach_back")).resolves.toBe("かけて6になる2つを探した");
    expect(llm.calls[0]?.user).toContain("自分の言葉で説明して");
  });

  it("silent は初回だけ答え、以降はLLMを呼ばずに無言(phaseごと)", async () => {
    const llm = stubLlm("うーん、わかんない");
    const student = createLlmStudent({ llm, persona: "silent", locale: "ja", scenario: ja });

    await expect(student.answer(turns, "lesson")).resolves.toBe("うーん、わかんない");
    await expect(student.answer(turns, "lesson")).resolves.toBeNull();
    // 授業で黙ったあとも、教え返しの1回目は喋る(カルテの材料が残らないと測れない)
    await expect(student.answer(turns, "teach_back")).resolves.toBe("うーん、わかんない");
    await expect(student.answer(turns, "teach_back")).resolves.toBeNull();
    expect(llm.calls).toHaveLength(2);
  });

  it("答えられなかった回は数に入れない(無言のあとにもう一度聞ける)", async () => {
    const llm = stubLlm("", "やっと出た");
    const student = createLlmStudent({ llm, persona: "silent", locale: "ja", scenario: ja });

    await expect(student.answer(turns, "lesson")).resolves.toBeNull();
    await expect(student.answer(turns, "lesson")).resolves.toBe("やっと出た");
  });

  it("ペルソナごとに別のsystemになる", async () => {
    const systems = await Promise.all(
      studentPersonas.map(async (persona) => {
        const llm = stubLlm("うん");
        await createLlmStudent({ llm, persona, locale: "ja", scenario: ja }).answer(
          turns,
          "lesson",
        );
        return llm.calls[0]?.system ?? "";
      }),
    );
    expect(new Set(systems).size).toBe(studentPersonas.length);
  });

  it("プロンプトはロケールと同じ言語で組む(混ぜると出力の言語が揺れる)", async () => {
    const jaLlm = stubLlm("うん");
    await createLlmStudent({
      llm: jaLlm,
      persona: "stuck",
      locale: "ja",
      scenario: ja,
    }).answer(turns, "lesson");
    const jaSystem = jaLlm.calls[0]?.system ?? "";
    expect(jaSystem).toContain("エックスの2乗");
    expect(jaSystem).not.toContain("x squared");

    const enLlm = stubLlm("um, factor it");
    await createLlmStudent({
      llm: enLlm,
      persona: "stuck",
      locale: "en",
      scenario: en,
    }).answer(turns, "lesson");
    const enSystem = enLlm.calls[0]?.system ?? "";
    expect(enSystem).toContain("x squared");
    expect(enSystem).not.toContain("エックス");
    expect(enLlm.calls[0]?.user).toContain("the question the senpai just asked");
  });

  it("長い授業でも直近の手順を渡す(要約の先頭で切れて問いかけが落ちない)", async () => {
    const llm = stubLlm("うん");
    const long: LessonTurn[] = Array.from({ length: studentContextTurns + 5 }, (_, index) => ({
      kind: "step",
      step: {
        index,
        speech: index === studentContextTurns + 4 ? "最後の問いかけ、何する?" : `手順${index}`,
        board: null,
      },
    }));

    await createLlmStudent({ llm, persona: "cooperative", locale: "ja", scenario: ja }).answer(
      long,
      "lesson",
    );

    expect(llm.calls[0]?.user).toContain("最後の問いかけ、何する?");
    expect(llm.calls[0]?.user).not.toContain("手順0");
  });
});

describe("isStudentPersona", () => {
  it("綴りの正本は studentPersonas だけ", () => {
    expect(studentPersonas.every((persona) => isStudentPersona(persona))).toBe(true);
    expect(isStudentPersona("scripted")).toBe(false);
    expect(isStudentPersona("")).toBe(false);
  });
});
