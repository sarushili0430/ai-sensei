import type { BoardStep } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import {
  asksForTeachBack,
  handsTurnToStudent,
  lessonSteps,
  stepAwaitsStudent,
  studentSilenceMarker,
  wroteOnBoard,
} from "../senpai.ts";
import type { TrialMetrics, TrialRecord } from "./trial.ts";

/**
 * 決定的スコアラー。**LLMを呼ばない純関数**で、試行レコードだけから導く。
 *
 * 判定は全部 `senpai.ts` から import する(`stepAwaitsStudent` /
 * `asksForTeachBack` / `wroteOnBoard` / `handsTurnToStudent`)。
 * ここに同じ正規表現を書き写すと、**本体の判定を直したのに評価だけ旧判定のまま**に
 * なり、直したことが数字に出ない — いちばん見つけにくいずれ方をする。
 *
 * 実行時に埋めて保存し、レポート側で**同じ関数で再計算できる**ようにしてある。
 * 指標を1つ足したとき、過去の run を撮り直さずに読み直せるのはそのため。
 */
export type { TrialMetrics } from "./trial.ts";

/**
 * `speech` が長い側の警戒線。契約の上限は120字(`boardSpeechMaxLength`)で、
 * そこは**スキーマが弾く安全弁**。100字を数えるのは、上限に達しないまま
 * 「板書に置くべきものを喋っている」授業を見つけるため
 * (§3-1 は `speech` を上限から**遠ざける**原則。実測の中央値は14字)。
 */
export const speechNearLimit = 100;

/**
 * `tex` が長い側の目安。「長い式は `=` の前で割って2手順にする」
 * (`prompts/README.md` の二重書きの表)には**コード側の相手がいない** —
 * W2でNode側の幅推定が入るまで、この件数がその約束の唯一の観測値になる。
 */
export const texOverLength = 60;

export function scoreTrial(record: TrialRecord): TrialMetrics {
  const locale: CurriculumLocale = record.meta.locale;
  const steps = lessonSteps(record.turns);
  const last = steps.at(-1);

  const speechLengths = steps.map((step) => step.speech.length);
  const texLengths = steps.flatMap((step) =>
    step.board !== null && step.board.kind === "latex" ? [step.board.tex.length] : [],
  );

  const rejectionsByReason: Record<string, number> = {};
  for (const rejection of record.rejections) {
    rejectionsByReason[rejection.reason] = (rejectionsByReason[rejection.reason] ?? 0) + 1;
  }

  const metrics: TrialMetrics = {
    // **「例外が出なかった」だけでは足りない。**手順が検証に落ちて配送が
    // `error` で降りた回も「最後まで走った」ではない(そのとき例外は出ない —
    // `BoardDelivery.append` は理由を返して静かに降りる)。
    ok: record.error === undefined && record.loop?.reason !== "error",
    steps_total: steps.length,
    rejections_total: record.rejections.length,
    rejections_by_reason: rejectionsByReason,
    wrote_on_board: wroteOnBoard(steps),
    board_null_ratio:
      steps.length === 0 ? 0 : steps.filter((step) => step.board === null).length / steps.length,
    speech_len_max: max(speechLengths),
    speech_len_mean: mean(speechLengths),
    speech_near_limit: speechLengths.filter((length) => length > speechNearLimit).length,
    tex_len_max: max(texLengths),
    tex_over_60: texLengths.filter((length) => length > texOverLength).length,
    awaits_declared: steps.filter((step) => step.awaits_student === true).length,
    // **申告が無いまま言い回しで拾えた手順。**ここが多いなら、板書プロンプトが
    // `awaits_student` を書けていない(#122 の判定はフォールバックで動いている)。
    awaits_inferred_only: steps.filter(
      (step) => step.awaits_student === undefined && handsTurnToStudent(step.speech, locale),
    ).length,
    last_step: lastStepKind(last, locale),
    duration_ms: record.meta.duration_ms,
    ...(record.meta.time_to_first_step_ms === undefined
      ? {}
      : { time_to_first_step_ms: record.meta.time_to_first_step_ms }),
    ...loopMetrics(record, locale),
    ...teachBackMetrics(record),
    ...karteMetrics(record),
  };

  return metrics;
}

/**
 * 最終手順の形。**授業の終わり方が3つに分かれる**:
 *
 *   - `teach_back` … 「自分の言葉で説明してみて」まで行った(予定どおり)
 *   - `awaits_student` … 問いかけで止まっている(往復の途中。L1では正常)
 *   - `neither` … 言い切って終わった = **渡し忘れ**。`teachBackFallback` が
 *     定型句で受け止めるが、そこに落ちた回数はプロンプトの成績
 *   - `none` … 手順がゼロ。板書が1行も出ていない
 */
function lastStepKind(
  last: BoardStep | undefined,
  locale: CurriculumLocale,
): TrialMetrics["last_step"] {
  if (last === undefined) return "none";
  if (asksForTeachBack(last.speech, locale)) return "teach_back";
  if (stepAwaitsStudent(last, locale)) return "awaits_student";
  return "neither";
}

/**
 * L2(授業の往復)の指標。**`stage` で切る。**
 *
 * L1のレコードにも `loop` は入っているが、あちらの `reason` は
 * `BoardCloseReason`(1パスの終わり方)で、L2の「渡し忘れ = completed」とは
 * 意味が違う。同じ欄に混ぜると、レポートが `completed` 率を教え方の指標として
 * 読んでしまう。
 */
function loopMetrics(
  record: TrialRecord,
  locale: CurriculumLocale,
): Partial<Pick<TrialMetrics, "loop_reason" | "passes" | "student_turns" | "silence_markers">> {
  if (record.meta.stage !== "loop") return {};
  const silence = studentSilenceMarker(locale);
  const spoken = record.turns.filter((turn) => turn.kind === "student");
  return {
    ...(record.loop === undefined
      ? {}
      : { loop_reason: record.loop.reason, passes: record.loop.passes }),
    // 無言の記録(`studentSilenceMarker`)は生徒の発話ではないので分けて数える。
    student_turns: spoken.filter((turn) => turn.text !== silence).length,
    silence_markers: spoken.filter((turn) => turn.text === silence).length,
  };
}

function teachBackMetrics(
  record: TrialRecord,
): Partial<Pick<TrialMetrics, "teach_back_turns" | "teach_back_closed">> {
  if (record.teach_back === undefined) return {};
  return {
    teach_back_turns: record.teach_back.messages.length,
    teach_back_closed: record.teach_back.closed_by_pattern,
  };
}

/**
 * カルテの件数。**中身の妥当性は見ない**(それは Stage B のジャッジ R7)。
 * `karte` は `unknown` のまま持っているので、形が違えば数えずに欄を出さない —
 * ここで契約を二重に検査すると、カルテのスキーマが動いたときに評価が落ちる。
 */
function karteMetrics(
  record: TrialRecord,
): Partial<Pick<TrialMetrics, "karte_holes" | "karte_said_well">> {
  if (record.karte === undefined || record.karte === null) return {};
  const karte = record.karte as { holes?: unknown; said_well?: unknown };
  return {
    ...(Array.isArray(karte.holes) ? { karte_holes: karte.holes.length } : {}),
    ...(Array.isArray(karte.said_well) ? { karte_said_well: karte.said_well.length } : {}),
  };
}

function max(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

/** 平均。小数第1位まで(レポートの表で桁が揺れないように丸める)。 */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
}
