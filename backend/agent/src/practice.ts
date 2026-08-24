import { type PracticeProblemDraft, practiceProblemDraftSchema } from "@ai-sensei/contract";
import { buildAllowedTopics, filterHoleTopicIds } from "@ai-sensei/guardrail";
import { practiceProblemSystemPrompt } from "@ai-sensei/prompts";
import { type LlmClient, extractJson } from "./complete.ts";
import type { SessionContext } from "./context.ts";
import type { JobLogger } from "./log.ts";
import { type LessonTurn, lessonContinuationRecapMaxLength, renderLessonRecap } from "./senpai.ts";

/**
 * 板書を材料に、復習問題を1問つくる(ADR 0009 / #176)。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【材料が反転している】ここが `karte.ts` との最大の違い
 * ─────────────────────────────────────────────────────────────────────────
 *
 * カルテの `quiz` は **transcript の `ユーザー:` の行だけ**から作っていた
 * (「先輩が教えた内容から作らない」— AIの誤読を間隔反復で3回強化しないため)。
 * こちらは逆で、**先輩が板書に書いた手順**が材料。教え返しを畳んだ結果、
 * 「本人が説明した内容」そのものが手に入らなくなったので、反転せざるを得なかった。
 *
 * 誤読の危険は消えていない。受けているのは3つ:
 *
 *   1. **`board_id` で材料を追える。**誤った問題が出たときに、どの板書から
 *      作ったかを引けないと原因を追う手段が無くなる
 *   2. **採点が `unclear` を持つ。**読めない答案を「間違い」にしない
 *   3. **許可集合で照合する。**範囲外の単元を問う問題を通知に載せない(下の門)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【作るのは「わかった」のときだけ】
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 呼ぶかどうかを決めるのは `agent.ts`。時間切れ・離脱では呼ばない
 * (#172 の決定13)。押されなかった = 到達していないので、そこで作った問題は
 * 「教わっていないことを問う」ことになる。
 */

export type BuildPracticeProblemOptions = {
  context: SessionContext;
  /** 授業で起きたこと。板書の手順と、合間の生徒の発話。 */
  turns: readonly LessonTurn[];
  llm: LlmClient;
  log?: Pick<JobLogger, "info" | "warn">;
};

/**
 * 板書から1問。作れなければ `null`。
 *
 * **例外を外に出さない。**ここで投げると `/complete` ごと落ち、
 * 会話は成立したのにセッションが完了扱いにならない。生成の失敗は
 * 「通知が予約されないだけ」で済ませる(#176 の確かめること)。
 */
export async function buildPracticeProblem({
  context,
  turns,
  llm,
  log,
}: BuildPracticeProblemOptions): Promise<PracticeProblemDraft | null> {
  const boardRecap = renderLessonRecap(turns, context.locale, lessonContinuationRecapMaxLength);

  let raw: string;
  try {
    raw = await llm.complete({
      system: practiceProblemSystemPrompt(
        {
          problem_text: context.problem_text,
          board_recap: boardRecap,
          allowed_topics: context.allowed_topics,
        },
        { locale: context.locale },
      ),
      user: practiceInstruction[context.locale],
      maxTokens: 600,
    });
  } catch (error) {
    log?.warn("practice_problem_llm_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    log?.warn("practice_problem_unparsable", {});
    return null;
  }

  // プロンプトは「作れないときは `{"topic_id": null}`」と言ってある。
  // **無理に作らせない**ほうが、教わっていないことを3日後にたずねるより安い。
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { topic_id?: unknown }).topic_id === null
  ) {
    log?.info("practice_problem_declined", {});
    return null;
  }

  const draft = practiceProblemDraftSchema.safeParse(parsed);
  if (!draft.success) {
    // 契約に合わない出力。**`answer` が空のものはここで落ちる** —
    // 答えの無い問題を保存すると、解いても何も返せない問題が通知に載る。
    log?.warn("practice_problem_invalid", { issues: draft.error.issues.length });
    return null;
  }

  // ガードレール2枚目。板書の見出しと同じ許可集合で照合する。
  //
  // **付け替えない。落とす。**カルテの穴は「本人が詰まった事実」だったので、
  // タグが外れても主単元へ付け替えて残していた。復習問題にはその事実が無い —
  // 範囲外のIDが付いた問題は、そもそも範囲外のことを問うている可能性が高く、
  // 付け替えると**中身は範囲外のまま、タグだけ正しい問題**が通知に載る。
  const allowed = buildAllowedTopics(context.allowed_topic_ids, { prerequisiteDepth: 0 });
  const { rejected } = filterHoleTopicIds([draft.data], allowed);
  const outOfScope = rejected[0];
  if (outOfScope) {
    log?.warn("practice_problem_out_of_scope", {
      topic_id: draft.data.topic_id,
      reason: outOfScope.reason,
    });
    return null;
  }

  log?.info("practice_problem_built", {
    topic_id: draft.data.topic_id,
    question_length: draft.data.question.length,
  });
  return draft.data;
}

/** 生成の指示。systemと同じ言語で頼む(混ぜると出力の言語が揺れる)。 */
const practiceInstruction: Record<"ja" | "en", string> = {
  ja: "この板書から、復習問題のJSONだけを返してください。",
  en: "Return only the practice problem JSON for this board.",
};
