import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardChannelMessage } from "@ai-sensei/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmClient } from "../karte.ts";
import type { LessonLlm } from "../lesson.ts";
import { studentSilenceMarker, teachBackPrompt } from "../senpai.ts";
import {
  defaultTeachBackExchanges,
  loopClock,
  loopSystemPrompt,
  runLoopTrial,
} from "./run-loop.ts";
import { type EvalScenario, findScenario } from "./scenario.ts";
import { createScriptedStudent } from "./student.ts";
import { type TrialRecord, promptSha256, readTrial, trialPath } from "./trial.ts";

/**
 * L2ランナーのテスト。**実ネットワークも実時間待ちも無い**
 * (stub `LessonLlm` / stub `LlmClient` / 台本の生徒 / `answerTimeoutMs` は数ms)。
 *
 * 見たいのは6つ:
 *   1. 問いかけ → 生徒の答え → **同じ板書**に続きが積まれること
 *   2. 無言の回に `studentSilenceMarker` が残り、指標に出ること
 *   3. `handed_over` のあと教え返しへ渡り、**締めの言い方**で止まること
 *   4. 渡し忘れ(`completed`)では本番と同じ定型句が先に入ること
 *   5. カルテがレコードに入り、L2の指標が埋まること(スキーマも通る)
 *   6. 作り直しを1回も呼ばないこと / 生徒役の失敗が `error` に残ること
 */

const scenario = findScenario("math_quadratic", "ja") as EvalScenario;
const topicId = scenario.context.allowed_topic_ids[0];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-run-loop-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const step = (index: number, speech: string, tex?: string): unknown => ({
  index,
  speech,
  board: tex === undefined ? null : { kind: "latex", tex },
});

const stepAwaiting = (index: number, speech: string, tex?: string): unknown => ({
  ...(step(index, speech, tex) as Record<string, unknown>),
  awaits_student: true,
});

function lessonJson(steps: readonly unknown[]): string {
  return JSON.stringify({ title: "二次方程式を因数分解で解く", topic_ids: [topicId], steps });
}

/** 出力を呼び出し順に返す板書LLM。**呼ばれた回数が作り直しの検出になる。** */
function stubLlm(...outputs: readonly string[]): LessonLlm & { asked: string[] } {
  const asked: string[] = [];
  let call = 0;
  return {
    asked,
    stream({ user }) {
      asked.push(user);
      const output = outputs[Math.min(call, outputs.length - 1)] ?? "";
      call += 1;
      return (async function* () {
        for (const part of output.match(/[\s\S]{1,9}/g) ?? []) {
          await Promise.resolve();
          yield part;
        }
      })();
    },
  };
}

/** 非ストリーミングのstub(教え返しの先輩・カルテ)。 */
function stubClient(...outputs: readonly string[]): LlmClient & {
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

const karteJson = JSON.stringify({
  said_well: ["かけて6になる2つを探すところまで言えた"],
  holes: [
    {
      topic_id: topicId,
      desc: "解の公式の根号の中で説明が止まった",
      severity: "medium",
      evidence: "えっと、そこがわかんない",
    },
  ],
  term_notes: [],
  followup_question: null,
});

/** 決定的な時計。1回呼ぶごとに 100ms 進む。 */
function fakeClock(): () => number {
  let at = 1_000;
  return () => {
    at += 100;
    return at;
  };
}

/** 授業 → 問いかけ → 答え → 教え返しへ渡す、うまくいった2パス。 */
const twoPasses = [
  lessonJson([
    step(0, "まず、式をそのまま書くね。", "x^2 - 5x + 6 = 0"),
    stepAwaiting(1, "この式、まず何する? 一言でいいよ。"),
    step(2, "ここは配送されない。", "x = 99"),
  ]),
  lessonJson([
    step(0, "そう、因数分解からいこう。", "(x-2)(x-3) = 0"),
    stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。"),
  ]),
];

type Overrides = Partial<Parameters<typeof runLoopTrial>[0]>;

function trialWith(llm: LessonLlm, overrides: Overrides = {}) {
  return runLoopTrial({
    scenario,
    trial: 1,
    llm,
    student: createScriptedStudent(["えっと、因数分解?", "かけて6になる2つを探した"]),
    conversationLlm: stubClient("今日はここまでにしよっか。"),
    karteLlm: stubClient(karteJson),
    model: "stub-model",
    runDir: dir,
    // 無言のときだけ実時間で待つ。テストは数msに絞る。
    answerTimeoutMs: 20,
    now: fakeClock(),
    ...overrides,
  });
}

describe("runLoopTrial", () => {
  it("問いかけで止まり、答えを受けて同じ板書に続きを積む", async () => {
    const llm = stubLlm(...twoPasses);
    const student = createScriptedStudent(["えっと、因数分解?", "かけて6になる2つを探した"]);
    const record = await trialWith(llm, { student });

    expect(record.loop).toEqual({
      reason: "handed_over",
      passes: 2,
      step_count: 4,
      opened: true,
    });

    // 板書は1枚のまま(開き直しは板書を消す信号)。index は往復をまたいで通し。
    const envelopes = record.envelopes as BoardChannelMessage[];
    expect(envelopes.filter((message) => message.type === "board_open")).toHaveLength(1);
    expect(
      envelopes
        .filter((message) => message.type === "board_step")
        .map((message) => (message.type === "board_step" ? message.step.index : -1)),
    ).toEqual([0, 1, 2, 3]);
    expect(envelopes[0]).toMatchObject({ board_id: "brd_eval_math_quadratic.ja_t1" });

    // 起きたことの列: 手順2つ → 生徒の答え → 手順2つ
    expect(record.turns.map((turn) => turn.kind)).toEqual([
      "step",
      "step",
      "student",
      "step",
      "step",
    ]);
    // 続きの指示に答えが入っている(= 同じ板書の続きがその答えから書かれた)
    expect(llm.asked[1]).toContain("えっと、因数分解?");
    expect(llm.asked[1]).toContain("続きだけを書きます");

    // 生徒は**問いかけの手順を読み上げた時点で**呼ばれている(speakフック駆動)
    const [firstAsk] = student.asked;
    expect(firstAsk?.phase).toBe("lesson");
    const lastSeen = firstAsk?.turns.at(-1);
    expect(lastSeen?.kind === "step" && lastSeen.step.speech).toContain("まず何する?");
    // 渡しの手順(「説明してみて」)では授業の答えを聞かない。番は会話フェーズにある。
    expect(student.asked.filter((entry) => entry.phase === "lesson")).toHaveLength(1);

    expect(record.metrics?.student_turns).toBe(1);
    expect(record.metrics?.silence_markers).toBe(0);
    expect(record.metrics?.passes).toBe(2);
    expect(record.metrics?.loop_reason).toBe("handed_over");
    expect(record.metrics?.ok).toBe(true);
  });

  it("答えが来なければ沈黙を残して続ける(transcriptには写さない)", async () => {
    const llm = stubLlm(
      lessonJson([stepAwaiting(0, "この式、まず何する?", "x^2 - 5x + 6 = 0")]),
      lessonJson([
        step(0, "因数分解からいくね。", "(x-2)(x-3) = 0"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。"),
      ]),
    );
    const record = await trialWith(llm, {
      student: createScriptedStudent([null, "えっと、わかんない"]),
    });

    expect(record.loop?.reason).toBe("handed_over");
    expect(
      record.turns.some(
        (turn) => turn.kind === "student" && turn.text === studentSilenceMarker("ja"),
      ),
    ).toBe(true);
    expect(record.metrics?.silence_markers).toBe(1);
    // 無言は生徒の発話ではない(カルテの材料に混ぜない)
    expect(record.metrics?.student_turns).toBe(0);
    // 続きの指示は「返事はなかった」を持って次のパスへ
    expect(llm.asked[1]).toContain(studentSilenceMarker("ja"));
  });

  it("handed_over のあと教え返しへ渡り、締めの言い方で止まる", async () => {
    const conversationLlm = stubClient("今日はここまでにしよっか。詰め込みすぎても入らないから。");
    const record = await trialWith(stubLlm(...twoPasses), { conversationLlm });

    expect(record.teach_back?.closed_by_pattern).toBe(true);
    // 渡してある回は定型句を重ねない。**生徒が先に喋る。**
    expect(record.teach_back?.messages).toEqual([
      { role: "student", text: "かけて6になる2つを探した" },
      { role: "senpai", text: "今日はここまでにしよっか。詰め込みすぎても入らないから。" },
    ]);
    expect(record.metrics?.teach_back_turns).toBe(2);
    expect(record.metrics?.teach_back_closed).toBe(true);

    // 会話のsystemは本番と同じ経路。板書の要約と残り時間が入っている。
    const [call] = conversationLlm.calls;
    expect(call?.system).toContain("(x-2)(x-3) = 0");
    expect(call?.system).toContain("えっと、因数分解?");
    // 模擬クロックは2パス + 生徒1発話ぶん進んでいる(実時計は見ない)
    const spent = loopClock.perPass * 2 + loopClock.perStudentTurn * 2;
    expect(call?.system).toContain(String(loopClock.startSeconds - spent));
    // userメッセージは、ここまでの会話を畳んだもの
    expect(call?.user).toContain("ユーザー: かけて6になる2つを探した");
  });

  it("渡し忘れ(completed)では本番と同じ定型句から教え返しに入る", async () => {
    const llm = stubLlm(lessonJson([step(0, "この形にすると答えが見えるよ。", "x = 2, 3")]));
    const record = await trialWith(llm, {
      student: createScriptedStudent(["因数分解して、かけて6になる2つを探した"]),
      conversationLlm: stubClient("うん、そこまで合ってる。次はどこから?"),
      teachBackExchanges: 2,
    });

    expect(record.loop?.reason).toBe("completed");
    expect(record.teach_back?.messages.map((message) => message.role)).toEqual([
      "senpai",
      "student",
      "senpai",
    ]);
    expect(record.teach_back?.messages[0]?.text).toBe(teachBackPrompt("ja"));
    // 締めの言い方が出ないまま上限に当たった回は、そのまま偽で残す
    expect(record.teach_back?.closed_by_pattern).toBe(false);
  });

  it("カルテをレコードに入れ、L2の指標まで埋める(スキーマも通る)", async () => {
    const karteLlm = stubClient(karteJson);
    const record = await trialWith(stubLlm(...twoPasses), { karteLlm });

    // 保存されたものと返り値が一致する(集計は必ずファイル側を読む)
    const path = trialPath(dir, { scenario_id: "math_quadratic", locale: "ja", trial: 1 });
    expect(readTrial(path)).toEqual(record);

    expect(record.meta.stage).toBe("loop");
    expect(record.meta.persona).toBe("scripted");
    expect(record.meta.model).toBe("stub-model");
    expect(record.meta.prompt_sha256).toBe(promptSha256(loopSystemPrompt(scenario)));
    expect(record.system_prompt).toBe(loopSystemPrompt(scenario));
    expect(record.meta.time_to_first_step_ms).toBeGreaterThan(0);

    expect(record.karte).toMatchObject({ said_well: ["かけて6になる2つを探すところまで言えた"] });
    expect(record.metrics?.karte_holes).toBe(1);
    expect(record.metrics?.karte_said_well).toBe(1);
    // カルテのプロンプトには、授業の答えと教え返しの説明の**両方**が入っている
    const transcript = karteLlm.calls[0]?.system ?? "";
    expect(transcript).toContain("えっと、因数分解?");
    expect(transcript).toContain("かけて6になる2つを探した");
    expect(record.error).toBeUndefined();
  });

  it("カルテが作れなかった回は、試行ごと分母から外さない", async () => {
    const record = await trialWith(stubLlm(...twoPasses), {
      karteLlm: stubClient("カルテは作れませんでした"),
    });

    // 形の違うカルテは件数を数えない(欄そのものが出ない)
    expect(record.metrics?.karte_holes).toBeUndefined();
    expect(record.karte).toMatchObject({
      error: expect.stringContaining("カルテを作れませんでした"),
    });
    // 板書と教え返しの測定は生きている
    expect(record.error).toBeUndefined();
    expect(record.metrics?.ok).toBe(true);
    expect(record.metrics?.teach_back_turns).toBe(2);
  });

  it("落ちた手順は作り直させずに数える(パスの数しかLLMを呼ばない)", async () => {
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 5x + 6 = 0"),
        // `speech` は120字まで。契約違反なのでワイヤーに出ない。
        step(1, "あ".repeat(200)),
      ]),
      lessonJson([
        step(0, "続きね。因数分解するとこう。", "(x-2)(x-3) = 0"),
        stepAwaiting(1, "じゃあ今の、自分の言葉で説明してみて。"),
      ]),
    );
    const record = await trialWith(llm);

    expect(llm.asked).toHaveLength(2);
    expect(record.rejections.map((rejection) => rejection.reason)).toEqual(["schema"]);
    expect(record.metrics?.rejections_by_reason).toEqual({ schema: 1 });
    // 落ちたパスでも積めた手順は有効。同じ板書で続きに入っている。
    expect(record.loop).toEqual({
      reason: "handed_over",
      passes: 2,
      step_count: 3,
      opened: true,
    });
  });

  it("生徒役が失敗した回は無言として降り、error に残す(授業は殺さない)", async () => {
    const record = await trialWith(stubLlm(...twoPasses), {
      student: {
        persona: "cooperative",
        answer: () => Promise.reject(new Error("429 rate limit")),
      },
    });

    expect(record.error).toContain("生徒シミュレータが失敗しました");
    expect(record.error).toContain("429");
    expect(record.metrics?.ok).toBe(false);
    // 授業そのものは最後まで走っている(無言として続けた)
    expect(record.loop?.reason).toBe("handed_over");
    expect(record.metrics?.silence_markers).toBe(1);
  });

  it("例外でも部分レコードを残す(errorつきで保存)", async () => {
    const llm: LessonLlm = {
      stream() {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("板書の生成に失敗しました: 429 rate limit")),
          }),
        };
      },
    };
    const record = await trialWith(llm);

    expect(record.error).toContain("429");
    expect(record.turns).toEqual([]);
    expect(record.envelopes).toEqual([]);
    expect(record.metrics?.ok).toBe(false);
    // 授業が届かなかった回に教え返しとカルテを足さない(成立した授業に見せない)
    expect(record.teach_back).toBeUndefined();
    expect(record.karte).toBeUndefined();
    expect(readTrial(trialPath(dir, record.meta)).error).toContain("429");
  });

  it("安全弁で降りた回は教え返しへ渡さない", async () => {
    const llm = stubLlm(
      lessonJson([
        step(0, "まず、式をそのまま書くね。", "x^2 - 5x + 6 = 0"),
        stepAwaiting(1, "この式、まず何する?"),
      ]),
    );
    const record = await trialWith(llm, { maxPasses: 1 });

    expect(record.loop?.reason).toBe("budget");
    expect(record.teach_back).toBeUndefined();
    expect(record.karte).toBeUndefined();
    expect(record.metrics?.teach_back_turns).toBeUndefined();
  });
});

describe("loopSystemPrompt", () => {
  it("札は1パス目のsystem(同じプロンプトなら sha256 が動かない)", () => {
    expect(loopClock.startSeconds).toBe(900);
    expect(defaultTeachBackExchanges).toBe(6);
    const twice: TrialRecord["meta"]["prompt_sha256"][] = [
      promptSha256(loopSystemPrompt(scenario)),
      promptSha256(loopSystemPrompt(scenario)),
    ];
    expect(twice[0]).toBe(twice[1]);
  });
});
