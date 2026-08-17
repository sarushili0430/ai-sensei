import type { BoardChannelMessage } from "@ai-sensei/contract";
import { BoardChannel, type BoardSink } from "../board.ts";
import {
  type BoardLessonDelivery,
  type BoardLessonResult,
  type LessonLlm,
  createAnthropicLessonClient,
  runBoardLesson,
} from "../lesson.ts";
import { senpaiBoardLessonPrompt } from "../senpai.ts";
import type { EvalEnv } from "./env.ts";
import { type EvalScenario, scenarioKey } from "./scenario.ts";
import { scoreTrial } from "./score.ts";
import { type TrialRecord, promptSha256, saveTrial, trialSchemaVersion } from "./trial.ts";

/**
 * L1 — 板書1パスを実LLMで走らせて、試行レコードに落とす。
 *
 * 配線は**本番と同じ部品**でだけ組む(`senpaiBoardLessonPrompt` →
 * `createAnthropicLessonClient` → `BoardChannel.startBoard()` → `runBoardLesson`)。
 * 違うのは終端2つだけ:
 *
 *   - sink … LiveKit の Text Streams の代わりに**封筒を配列へ溜める**
 *   - speak … TTSの代わりに no-op(最初の手順が届いた時刻だけ取る)
 *
 * **作り直し(StepRepair / HeadRepair)は効かせない。**`runBoardLesson` は
 * 本番の作り直しを常に渡してくるので、こちらは `delivery` の側で
 * `maxRepairAttempts: 0` を強制する(下の `withoutRepair`)。直した後の成績を
 * 測ると、プロンプトが**素で守れているか**が見えなくなる — 評価が欲しい信号は
 * 「何回落ちたか」で、「直せば通ったか」ではない。
 */

/**
 * プロンプトに渡す残り時間。**固定値。**
 *
 * 実時計を入れると `remaining_seconds` が試行ごとに変わり、
 * **同じプロンプトでも `prompt_sha256` が毎回変わる** = before/after の
 * 比較が成立しなくなる。600 は `max_seconds: 900` の授業の序盤にあたる値で、
 * 締めに入る判断(会話プロンプト側の分岐)がまだ発火しない帯。
 */
export const defaultRemainingSeconds = 600;

/** 本番と同じ経路で板書 system を組む。`run.json` の sha256 もこれで取る。 */
export function boardSystemPrompt(
  scenario: EvalScenario,
  remainingSeconds: number = defaultRemainingSeconds,
): string {
  return senpaiBoardLessonPrompt({ context: scenario.context, remainingSeconds });
}

/** 評価用の板書クライアント。`agent.ts` と同じ関数・同じ既定(SSE / thinking無効)。 */
export function createBoardLlm(env: EvalEnv, model: string = env.boardModel): LessonLlm {
  return createAnthropicLessonClient({
    apiKey: env.apiKey,
    model,
    ...(env.baseUrl === undefined ? {} : { baseUrl: env.baseUrl }),
  });
}

export type RunBoardTrialOptions = {
  scenario: EvalScenario;
  /** 1始まり。ファイル名の `t<N>` になる。 */
  trial: number;
  /** 実LLM(`createBoardLlm`)か、テストのstub。 */
  llm: LessonLlm;
  /** メタに残すモデル名。stubを使うテストでは何でもよい。 */
  model: string;
  /** レコードの置き場。ここへ `<id>.<locale>.t<N>.json` を書く。 */
  runDir: string;
  remainingSeconds?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 時刻の注入。テストを決定的にするためだけの穴。 */
  now?: () => number;
};

/**
 * 1試行ぶん走らせて保存する。**例外を投げない。**
 *
 * 途中で落ちた試行も一次資料で、そこまでに溜まった封筒とプロンプト本文は
 * 「何が壊れたか」を読むための材料そのもの。投げて上へ返すと、直列で回している
 * run が1本の失敗で止まり、**払ったぶんの記録が残らない**。
 */
export async function runBoardTrial(options: RunBoardTrialOptions): Promise<TrialRecord> {
  const {
    scenario,
    trial,
    llm,
    model,
    runDir,
    remainingSeconds = defaultRemainingSeconds,
    maxTokens,
    signal,
    now = Date.now,
  } = options;

  const system = boardSystemPrompt(scenario, remainingSeconds);
  const envelopes: BoardChannelMessage[] = [];
  const sink: BoardSink = {
    async send(message) {
      envelopes.push(message);
    },
  };

  // **配送層は上流の例外を飲む。**`BoardDelivery.append` は LLM が投げても
  // `reason: "error"` を返して静かに降りる(生徒の前で板書を殺さないため)。
  // だから `runBoardLesson` の外では 429 もタイムアウトも観測できない —
  // 理由が残るのは `log.warn("board_append_failed")` の1行だけなので、それを拾う。
  // **ログの受け皿は `BoardChannel` に渡す**(`BoardDelivery` はそこから貰う)。
  const warnings: { event: string; fields: Record<string, unknown> }[] = [];
  const log = {
    info: () => undefined,
    warn: (event: string, fields: Record<string, unknown> = {}) => {
      warnings.push({ event, fields });
    },
  };

  const key = scenarioKey(scenario);
  const channel = new BoardChannel({
    sessionId: `${scenario.context.session_id}_t${trial}`,
    locale: scenario.locale,
    sink,
    // 見出しの `topic_ids` の照合。本番と同じ集合(前提はシナリオ側で入っている)。
    allowedTopicIds: scenario.context.allowed_topic_ids,
    // **board_id を決定的にする。**試行のJSONを diff するとき、UUIDが毎回変わると
    // 封筒の全行が差分になって、板書の中身の違いが読めない。
    newBoardId: () => `brd_eval_${key}_t${trial}`,
    log,
  });
  const board = channel.startBoard();

  const startedAt = now();
  let firstStepAt: number | undefined;

  let result: BoardLessonResult | undefined;
  let thrown: string | undefined;
  try {
    result = await runBoardLesson({
      llm,
      system,
      locale: scenario.locale,
      delivery: withoutRepair(board),
      log,
      // 読み上げは無い。**最初の手順が出るまで**だけ測る — 本番でそこは
      // 「冒頭の無音」として直に聞こえる時間(§3-2)で、モデルを替えたときに
      // いちばん先に動く数字。
      speak: async () => {
        firstStepAt ??= now();
      },
      ...(signal === undefined ? {} : { signal }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }

  const failure = thrown ?? transportFailure(warnings);

  const record: TrialRecord = {
    meta: {
      schema_version: trialSchemaVersion,
      scenario_id: scenario.id,
      locale: scenario.locale,
      stage: "board",
      trial,
      model,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: Math.max(0, now() - startedAt),
      prompt_sha256: promptSha256(system),
      ...(firstStepAt === undefined
        ? {}
        : { time_to_first_step_ms: Math.max(0, firstStepAt - startedAt) }),
    },
    system_prompt: system,
    turns: (result?.steps ?? []).map((step) => ({ kind: "step" as const, step })),
    envelopes,
    rejections: result?.rejections ?? [],
    ...(result === undefined
      ? {}
      : {
          loop: {
            // L1は1パス。`reason` は `append()` の終わり方(`BoardCloseReason`)で、
            // L2の `LessonLoopReason` の部分集合。
            reason: result.reason,
            passes: 1,
            step_count: result.step_count,
            opened: result.opened,
          },
        }),
    ...(failure === undefined ? {} : { error: failure }),
  };

  const scored: TrialRecord = { ...record, metrics: scoreTrial(record) };
  saveTrial(runDir, scored);
  return scored;
}

/**
 * **通信の失敗を、モデルの失敗に混ぜない**(`docs/figeval` の読み方と同じ)。
 *
 * `board_append_failed` は3つの理由で出る: 上流(LLM)の例外・封筒の契約違反・
 * 送信の失敗。**`stream_error` が真のときだけは別**で、それはモデルが吐いた
 * JSONが壊れていた(`BoardStreamError`)= モデルの成績そのもの。だから
 * そちらは `error` に入れず、`reason: "error"` と `metrics.ok = false` だけで残す。
 *
 * この切り分けが `record.error` の意味になる:
 *   - `error` あり … ハーネス側の事故。**分母から外して読む**
 *   - `error` なし で `ok = false` … モデルが板書を出しきれなかった
 */
function transportFailure(
  warnings: readonly { event: string; fields: Record<string, unknown> }[],
): string | undefined {
  const failed = warnings.find(
    (warning) => warning.event === "board_append_failed" && warning.fields["stream_error"] !== true,
  );
  if (failed === undefined) return undefined;
  const message = failed.fields["message"];
  return typeof message === "string" ? message : "board_append_failed";
}

/**
 * 作り直しを断る `delivery` のかぶせもの。
 *
 * `runBoardLesson` は `repair` / `repairHead` を必ず渡す(本番はそれで正しい)。
 * 上限回数を0にすると `BoardDelivery` はどちらも**呼ばずに**降りるので、
 * 落ちた手順は `rejections` に残り、そのパスは `reason: "error"` で終わる。
 * これが評価で見たい素の違反率で、直った後の成績ではない。
 */
function withoutRepair(delivery: BoardLessonDelivery): BoardLessonDelivery {
  return {
    append: (appendOptions) => delivery.append({ ...appendOptions, maxRepairAttempts: 0 }),
  };
}
