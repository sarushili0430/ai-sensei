import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EvalEnvError, loadEvalEnv } from "./env.ts";
import { boardSystemPrompt, createBoardLlm, runBoardTrial } from "./run-board.ts";
import {
  checkScenario,
  evalScenarios,
  scenarioKey,
  selectScenarios,
  subjectOfScenario,
} from "./scenario.ts";
import {
  type TrialRecord,
  loadTrials,
  promptSha256,
  readTrial,
  saveRunManifest,
  trialExists,
  trialPath,
} from "./trial.ts";

/**
 * 評価ハーネスの入口。
 *
 *   eval run    --stage board --scenario <id|all> --locale ja|en|all --trials N [--out <dir>] [--model <m>]
 *   eval list
 *   eval report <runDir> [<candidateRunDir>]   (Stage B)
 *   eval judge  <runDir>                        (Stage B)
 *
 * **`cwd` に依存しない。**`--out` を省いたときの置き場は `import.meta.dirname` から
 * 引いた `backend/agent/eval-out/` で、どこから起動しても同じ場所に落ちる
 * (`pnpm --filter @ai-sensei/agent eval` はパッケージ直下で走るが、素の
 * `node backend/agent/src/eval/cli.ts` はリポジトリルートで走る)。
 * `--out` を明示したときだけ `cwd` 基準で解く — そちらは人が今いる場所の話だから。
 *
 * **シナリオ × 試行は直列。**並列にするとレート制限に当たったときの落ち方が
 * 試行ごとにばらつき、通信の失敗がモデルの成績に混ざる(`docs/figeval` の
 * 「通信の失敗をモデルの失敗に混ぜない」と同じ)。速さは要らない。
 */

/** `--out` 省略時の置き場。`.gitignore` に入れてある(実LLMの出力は追跡しない)。 */
const defaultOutRoot = resolve(import.meta.dirname, "..", "..", "eval-out");

const options = {
  stage: { type: "string" },
  scenario: { type: "string" },
  locale: { type: "string" },
  trials: { type: "string" },
  out: { type: "string" },
  model: { type: "string" },
  persona: { type: "string" },
} as const;

type Values = { [K in keyof typeof options]?: string };

const usage = [
  "使い方:",
  "  eval run    --stage board --scenario <id|all> --locale ja|en|all --trials N [--out <dir>] [--model <m>]",
  "  eval list",
  "  eval report <runDir> [<candidateRunDir>]",
  "  eval judge  <runDir>",
  "",
  "  --stage    board(L1: 板書1パス) / loop(L2: 授業の往復。Stage C)",
  "  --scenario シナリオid。省略か all で全部(`eval list` で一覧)",
  "  --locale   ja / en / all",
  "  --trials   1シナリオあたりの試行回数(既定 1)",
  "  --out      レコードの置き場。省略すると backend/agent/eval-out/<stage>-<時刻>",
  "  --model    板書LLMのモデル(既定は EVAL_MODEL_BOARD)",
  "  --persona  L2の生徒ペルソナ(Stage C)",
].join("\n");

export async function main(argv: readonly string[]): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: [...argv], options, allowPositionals: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 1;
  }

  const [command, ...rest] = positionals;
  switch (command) {
    case "run":
      return await runCommand(values, [...argv]);
    case "list":
      return listCommand();
    case "report":
      return reportCommand(rest);
    case "judge":
      console.error("Stage B: ジャッジ(judge.ts)は未実装です");
      return 1;
    default:
      console.error(
        `${command === undefined ? "コマンドを指定してください" : `不明なコマンド: ${command}`}\n\n${usage}`,
      );
      return 1;
  }
}

function listCommand(): number {
  for (const scenario of evalScenarios) {
    const ids = scenario.context.allowed_topic_ids;
    console.log(
      [
        scenarioKey(scenario).padEnd(22),
        subjectOfScenario(scenario).padEnd(7),
        scenario.context.kind.padEnd(6),
        `${ids[0] ?? "-"}${ids.length > 1 ? ` (+${ids.length - 1})` : ""}`.padEnd(34),
        scenario.description,
      ].join(" "),
    );
    // 壊れたシナリオは走らせる前に見せる。**測れてしまうのがいちばん困る** —
    // 範囲外の topic_id や言語の食い違いは、板書が出たまま数字だけが意味を失う。
    for (const issue of checkScenario(scenario)) console.log(`  ! ${issue}`);
  }
  return 0;
}

async function runCommand(values: Values, argv: string[]): Promise<number> {
  const stage = values.stage ?? "board";
  if (stage === "loop") {
    console.error("Stage C: 授業の往復(run-loop.ts)は未実装です");
    return 1;
  }
  if (stage !== "board") {
    console.error(`--stage は board か loop です: ${stage}`);
    return 1;
  }

  const locale = values.locale ?? "all";
  if (locale !== "ja" && locale !== "en" && locale !== "all") {
    console.error(`--locale は ja / en / all です: ${locale}`);
    return 1;
  }

  const trials = Number(values.trials ?? "1");
  if (!Number.isInteger(trials) || trials < 1) {
    console.error(`--trials は1以上の整数です: ${values.trials}`);
    return 1;
  }

  const selected = selectScenarios({ scenario: values.scenario ?? "all", locale });
  if (selected.length === 0) {
    console.error(
      [
        `当てはまるシナリオがありません(--scenario ${values.scenario ?? "all"} --locale ${locale})`,
        `用意してあるのは: ${evalScenarios.map((entry) => scenarioKey(entry)).join(", ")}`,
      ].join("\n"),
    );
    return 1;
  }

  // 壊れた入力で測ると、板書は出るのに数字が意味を失う。走らせる前に止める。
  const broken = selected.flatMap((scenario) =>
    checkScenario(scenario).map((issue) => `${scenarioKey(scenario)}: ${issue}`),
  );
  if (broken.length > 0) {
    console.error(`シナリオが壊れています(測る前に直してください):\n  ${broken.join("\n  ")}`);
    return 1;
  }

  let env: ReturnType<typeof loadEvalEnv>;
  try {
    env = loadEvalEnv();
  } catch (error) {
    // 鍵が無いだけでスタックを出さない。直し方は1行で足りる。
    if (error instanceof EvalEnvError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const model = values.model ?? env.boardModel;
  const runDir =
    values.out === undefined
      ? resolve(defaultOutRoot, `${stage}-${stamp(new Date())}`)
      : resolve(process.cwd(), values.out);

  saveRunManifest(runDir, {
    stage,
    created_at: new Date().toISOString(),
    model,
    argv,
    prompt_sha256: Object.fromEntries(
      selected.map((scenario) => [
        scenarioKey(scenario),
        promptSha256(boardSystemPrompt(scenario)),
      ]),
    ),
  });

  const llm = createBoardLlm(env, model);
  const records: TrialRecord[] = [];

  for (const scenario of selected) {
    for (let trial = 1; trial <= trials; trial += 1) {
      const label = `${scenarioKey(scenario)} t${trial}/${trials}`;
      const at = { scenario_id: scenario.id, locale: scenario.locale, trial };

      // **既にあれば走らせない。**途中で止めた run を続けられるようにしておくのは、
      // 1試行ぶんの実LLMの支払いを捨てないため(`docs/figeval` と同じ)。
      if (trialExists(runDir, at)) {
        console.error(`${label}  skip(既にある)`);
        records.push(readTrial(trialPath(runDir, at)));
        continue;
      }

      const record = await runBoardTrial({ scenario, trial, llm, model, runDir });
      records.push(record);
      console.error(`${label}  ${progressOf(record)}`);
    }
  }

  console.log(summarize(runDir, records));
  return 0;
}

/**
 * Stage A の `report`。**サマリは出すが、成功にはしない。**
 *
 * before/after の比較(Markdown)は Stage B の `report.ts` の仕事で、そこが入るまでは
 * 「レポートが出た」と扱われないよう終了コードを1にしてある(スクリプトから回した
 * ときに、無いものを在るものとして拾わせない)。
 */
function reportCommand(dirs: readonly string[]): number {
  const [baseDir, candidateDir] = dirs;
  if (baseDir === undefined) {
    console.error(`report には run ディレクトリが要ります\n\n${usage}`);
    return 1;
  }

  const resolved = resolve(process.cwd(), baseDir);
  const records = loadTrials(resolved);
  if (records.length === 0) {
    console.error(`試行レコードがありません: ${resolved}`);
    return 1;
  }

  console.log(summarize(resolved, records));
  console.error(
    candidateDir === undefined
      ? "Stage B: 比較レポート(report.ts)は未実装です"
      : "Stage B: run の比較(report.ts の compareRuns)は未実装です",
  );
  return 1;
}

/** 1試行ぶんの進捗。**stderr へ1行**(stdout はサマリだけに保つ)。 */
function progressOf(record: TrialRecord): string {
  const metrics = record.metrics;
  const parts = [
    `steps=${metrics?.steps_total ?? 0}`,
    `rejections=${metrics?.rejections_total ?? 0}`,
    `last=${metrics?.last_step ?? "none"}`,
    `${(record.meta.duration_ms / 1000).toFixed(1)}s`,
  ];
  if (record.meta.time_to_first_step_ms !== undefined) {
    parts.push(`first=${(record.meta.time_to_first_step_ms / 1000).toFixed(1)}s`);
  }
  if (record.error !== undefined) parts.push(`error=${record.error.slice(0, 60)}`);
  return parts.join(" ");
}

/**
 * run のサマリ。**シナリオごとに1行**で、最後に run ディレクトリを出す
 * (次に打つ `eval report <dir>` にそのまま貼れる)。
 */
export function summarize(runDir: string, records: readonly TrialRecord[]): string {
  // 並べ直さない。`run` は走らせた順、`report` は `loadTrials` がそろえた順で、
  // どちらも決定的。ここでソートすると `run` の進捗行とサマリの順が食い違う。
  const keys = [...new Set(records.map((record) => keyOf(record)))];
  const lines = keys.map((key) => {
    const rows = records.filter((record) => keyOf(record) === key);
    const ok = rows.filter((row) => row.metrics?.ok === true).length;
    const wrote = rows.filter((row) => row.metrics?.wrote_on_board === true).length;
    const teachBack = rows.filter((row) => row.metrics?.last_step === "teach_back").length;
    const rejections = rows.reduce((sum, row) => sum + (row.metrics?.rejections_total ?? 0), 0);
    const steps = rows.reduce((sum, row) => sum + (row.metrics?.steps_total ?? 0), 0);
    return [
      key.padEnd(22),
      `trials=${rows.length}`,
      `ok=${ok}/${rows.length}`,
      `steps=${(steps / rows.length).toFixed(1)}`,
      `wrote=${wrote}/${rows.length}`,
      `rejections=${rejections}`,
      `teach_back=${teachBack}/${rows.length}`,
    ].join(" ");
  });

  return [...lines, `run: ${displayPath(runDir)} (${records.length} 試行)`].join("\n");
}

/** `cwd` の中なら相対、外なら絶対。`../../..` を貼らせないため。 */
function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

function keyOf(record: TrialRecord): string {
  return `${record.meta.scenario_id}.${record.meta.locale}`;
}

/** `20260817-073000` 形式。ディレクトリ名に使うので記号を落とす。 */
export function stamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

// `scripts/verify-strip-types.ts` と同じ直接起動の判定。テストから import しても走らせない。
const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(resolve(process.argv[1]), resolve(import.meta.dirname, "cli.ts")) === "";

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
