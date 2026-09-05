import type { BoardStep } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import type { LlmClient } from "./complete.ts";
import { readSessionContext } from "./context.ts";
import { buildPracticeProblem } from "./practice.ts";
import type { LessonTurn } from "./senpai.ts";
import { sessionMetadataJson } from "./test-support.ts";

/**
 * 板書から復習問題を作る側のテスト(ADR 0009 / #176)。
 *
 * 見たいのは3つ:
 *
 *   1. **材料が板書であること。**カルテの `quiz` は transcript の `ユーザー:` の行だけ
 *      から作っていた。反転したのがこの変更の中心なので、板書の手順が
 *      プロンプトへ渡っていることを固定する
 *   2. **落ちても `null` に畳むこと。**ここで投げると `/complete` ごと落ち、
 *      会話は成立したのにセッションが完了扱いにならない
 *   3. **範囲外の単元を通さないこと。**付け替えずに落とす — 付け替えると
 *      「中身は範囲外のまま、タグだけ正しい問題」が3日後に届く
 */

const context = readSessionContext(
  sessionMetadataJson({
    session_id: "ses_practice",
    locale: "ja",
    kind: "new",
    problem_text: "x² − 4x + 1 = 0 の解の個数を求めよ。",
    allowed_topics: "- M1-NIJI-HANBETSU — 数学I / 二次関数 / 判別式と解の個数",
    allowed_topic_ids: ["M1-NIJI-HANBETSU"],
  }),
);

function step(index: number, speech: string, tex?: string): BoardStep {
  return {
    index,
    speech,
    board: tex === undefined ? null : { kind: "latex", tex },
  };
}

const turns: LessonTurn[] = [
  { kind: "step", step: step(0, "解の個数は、グラフが x軸と何回交わるかで決まる。") },
  { kind: "step", step: step(1, "判別式はこれ。", "D = b^2 - 4ac") },
  { kind: "student", text: "16 引く 4 で 12 ですか?" },
  { kind: "step", step: step(2, "そう、12。", "D = 16 - 4 = 12") },
];

/** 出力を1回だけ返すLLM。渡された system を記録する。 */
function stubLlm(output: string): LlmClient & { systems: string[] } {
  const systems: string[] = [];
  return {
    systems,
    async complete({ system }) {
      systems.push(system);
      return output;
    },
  };
}

const validJson = JSON.stringify({
  topic_id: "M1-NIJI-HANBETSU",
  question: "x² − 6x + 5 = 0 の解の個数は?",
  answer: "D = 36 − 20 = 16 で D > 0 なので 2個",
});

describe("buildPracticeProblem", () => {
  it("板書の手順を材料にしてプロンプトを組む", async () => {
    const llm = stubLlm(validJson);
    const problem = await buildPracticeProblem({ context, turns, llm });

    expect(problem).toEqual({
      topic_id: "M1-NIJI-HANBETSU",
      question: "x² − 6x + 5 = 0 の解の個数は?",
      answer: "D = 36 − 20 = 16 で D > 0 なので 2個",
    });

    const system = llm.systems[0] ?? "";
    // **板書が入っていること。**ここが transcript に戻ると、ADR 0009 の反転が消える。
    expect(system).toContain("D = b^2 - 4ac");
    expect(system).toContain("解の個数は、グラフが x軸と何回交わるかで決まる。");
    expect(system).toContain("x² − 4x + 1 = 0 の解の個数を求めよ。");
    expect(system).toContain("M1-NIJI-HANBETSU");
  });

  /**
   * `answer` が空の問題を保存すると、**解いても何も返せない問題**が通知に載る。
   * 契約(`practiceProblemDraftSchema`)で必須にしてあるので、ここで落ちる。
   */
  it("正解の無い問題は作らない", async () => {
    const llm = stubLlm(JSON.stringify({ topic_id: "M1-NIJI-HANBETSU", question: "解の個数は?" }));
    expect(await buildPracticeProblem({ context, turns, llm })).toBeNull();
  });

  /**
   * **付け替えずに落とす。**穴は「本人が詰まった事実」だったので主単元へ付け替えて
   * 残していたが、問題にはその事実が無い。範囲外のIDが付いた問題は中身も範囲外で
   * ある可能性が高く、付け替えると「中身は範囲外のまま、タグだけ正しい問題」になる。
   */
  it("許可集合の外の単元は落とす(主単元へ付け替えない)", async () => {
    const llm = stubLlm(
      JSON.stringify({
        topic_id: "M3-BIBUN-GOKAN",
        question: "この関数の導関数は?",
        answer: "2x",
      }),
    );
    expect(await buildPracticeProblem({ context, turns, llm })).toBeNull();
  });

  /**
   * プロンプトは「作れないときは `{"topic_id": null}`」と言ってある。
   * **無理に作らせない**ほうが、教わっていないことを3日後にたずねるより安い。
   */
  it("モデルが「作れない」と言ったら作らない", async () => {
    const llm = stubLlm(JSON.stringify({ topic_id: null }));
    expect(await buildPracticeProblem({ context, turns, llm })).toBeNull();
  });

  it("JSONでない出力でも例外を外に出さない", async () => {
    const llm = stubLlm("ごめん、うまく作れなかった");
    expect(await buildPracticeProblem({ context, turns, llm })).toBeNull();
  });

  /**
   * ここで投げると `/complete` ごと落ち、**会話は成立したのにセッションが
   * 完了扱いにならない**。生成の失敗は「通知が予約されないだけ」で済ませる。
   */
  it("LLMが落ちても例外を外に出さない", async () => {
    const llm: LlmClient = {
      async complete() {
        throw new Error("upstream is down");
      },
    };
    expect(await buildPracticeProblem({ context, turns, llm })).toBeNull();
  });
});
