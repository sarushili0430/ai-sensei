import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type EvalEnv, EvalEnvError, loadEvalEnv } from "./env.ts";
import { createJudgeLlm, judgeRun } from "./judge.ts";
import { compareRuns, summarizeRun } from "./report.ts";
import { boardSystemPrompt, createBoardLlm, runBoardTrial } from "./run-board.ts";
import {
  createConversationLlm,
  createKarteLlm,
  createStudentLlm,
  loopSystemPrompt,
  runLoopTrial,
} from "./run-loop.ts";
import {
  checkScenario,
  evalScenarios,
  scenarioKey,
  selectScenarios,
  subjectOfScenario,
} from "./scenario.ts";
import { createLlmStudent, isStudentPersona, studentPersonas } from "./student.ts";
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
 *   eval run    --stage board|loop --scenario <id|all> --locale ja|en|all --trials N [--out <dir>] [--model <m>] [--persona <p>]
 *   eval list
 *   eval judge  <runDir>
 *   eval report <runDir> [<candidateRunDir>]
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
  "  eval run    --stage board|loop --scenario <id|all> --locale ja|en|all --trials N [--out <dir>] [--model <m>] [--persona <p>]",
  "  eval list",
  "  eval judge  <runDir>",
  "  eval report <runDir> [<candidateRunDir>]",
  "",
  "  --stage    board(L1: 板書1パス) / loop(L2: 授業の往復+教え返し+カルテ)",
  "  --scenario シナリオid。省略か all で全部(`eval list` で一覧)",
  "  --locale   ja / en / all",
  "  --trials   1シナリオあたりの試行回数(既定 1)",
  "  --out      レコードの置き場。省略すると backend/agent/eval-out/<stage>-<時刻>",
  "  --model    板書LLMのモデル(既定は EVAL_MODEL_BOARD)",
  `  --persona  L2の生徒ペルソナ: ${studentPersonas.join(" / ")}(既定 cooperative)`,
  "",
  "  judge  は各試行にルーブリック判定を書き足す(要 ANTHROPIC_API_KEY)",
  "  report は決定的スコア(+あればジャッジ)を集計する。鍵は要らない",
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
      return await judgeCommand(rest);
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
  if (stage !== "board" && stage !== "loop") {
    console.error(`--stage は board か loop です: ${stage}`);
    return 1;
  }

  // ペルソナはL2の生徒役。boardで黙って無視すると「効いているつもりの引数」になるので弾く。
  if (values.persona !== undefined && stage === "board") {
    console.error("--persona は --stage loop 専用です(板書1パスに生徒は登場しません)");
    return 1;
  }
  const persona = values.persona ?? "cooperative";
  if (!isStudentPersona(persona)) {
    console.error(`--persona は ${studentPersonas.join(" / ")} です: ${persona}`);
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

  // L1とL2でsystemの組み方が違う(remaining_secondsの起点)。sha256は実際に測る側で取る。
  const systemOf = stage === "board" ? boardSystemPrompt : loopSystemPrompt;
  saveRunManifest(runDir, {
    stage,
    created_at: new Date().toISOString(),
    model,
    argv,
    prompt_sha256: Object.fromEntries(
      selected.map((scenario) => [scenarioKey(scenario), promptSha256(systemOf(scenario))]),
    ),
  });

  const llm = createBoardLlm(env, model);
  // L2の脇役。1つのrunで使い回す(シナリオごとに作り直す理由が無い)。
  const supporting = stage === "loop" ? loopSupportingLlms(env) : undefined;
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

      const record =
        supporting === undefined
          ? await runBoardTrial({ scenario, trial, llm, model, runDir })
          : await runLoopTrial({
              scenario,
              trial,
              llm,
              student: createLlmStudent({
                llm: supporting.student,
                persona,
                locale: scenario.locale,
                scenario,
              }),
              conversationLlm: supporting.conversation,
              karteLlm: supporting.karte,
              model,
              runDir,
            });
      records.push(record);
      console.error(`${label}  ${progressOf(record)}`);
    }
  }

  console.log(summarize(runDir, records));
  return 0;
}

/** L2で先輩の会話・カルテ・生徒役を受け持つクライアント。板書LLMとは別のモデル。 */
function loopSupportingLlms(env: EvalEnv) {
  return {
    student: createStudentLlm(env),
    conversation: createConversationLlm(env),
    karte: createKarteLlm(env),
  };
}

/**
 * 集計。**鍵は要らない**(読むのは保存済みの試行レコードだけ)。
 *
 * 1本なら要約、2本ならbefore/afterの比較Markdown。stdoutへ出すので、
 * `> report.md` でそのままPRに貼れる。
 */
function reportCommand(dirs: readonly string[]): number {
  const [baseDir, candidateDir] = dirs;
  if (baseDir === undefined) {
    console.error(`report には run ディレクトリが要ります\n\n${usage}`);
    return 1;
  }

  // 空ディレクトリを黙ってレポートすると「0件で緑」に見える。測っていないことは失敗。
  for (const dir of [baseDir, candidateDir]) {
    if (dir === undefined) continue;
    const resolved = resolve(process.cwd(), dir);
    if (loadTrials(resolved).length === 0) {
      console.error(`試行レコードがありません: ${resolved}`);
      return 1;
    }
  }

  const base = resolve(process.cwd(), baseDir);
  console.log(
    candidateDir === undefined
      ? summarizeRun(base)
      : compareRuns(base, resolve(process.cwd(), candidateDir)),
  );
  return 0;
}

/**
 * ルーブリック判定を run の各試行へ書き足す。
 *
 * **ディレクトリの検証を鍵より先に**やる(`run` と同じ並び。引数間違いで
 * ネットワークに触らせない)。判定済みの試行は `judgeRun` が飛ばすので、
 * 途中で止めても同じコマンドで続きから回る。
 */
async function judgeCommand(dirs: readonly string[]): Promise<number> {
  const [dir] = dirs;
  if (dir === undefined) {
    console.error(`judge には run ディレクトリが要ります\n\n${usage}`);
    return 1;
  }

  const resolved = resolve(process.cwd(), dir);
  if (loadTrials(resolved).length === 0) {
    console.error(`試行レコードがありません: ${resolved}`);
    return 1;
  }

  let env: ReturnType<typeof loadEvalEnv>;
  try {
    env = loadEvalEnv();
  } catch (error) {
    if (error instanceof EvalEnvError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const result = await judgeRun(resolved, {
    llm: createJudgeLlm(env),
    model: env.judgeModel,
    onProgress: (line) => console.error(line),
  });
  for (const warning of result.warnings) console.error(`! ${warning}`);
  if (result.ruleErrors > 0) {
    // 読めなかった応答は成績ではない。もう一度 judge を打てばそこだけ聞き直す。
    console.error(`! 応答を読めなかったルールが ${result.ruleErrors} 件(再実行で聞き直せます)`);
  }

  console.log(summarizeRun(resolved));
  return 0;
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
  if (metrics?.loop_reason !== undefined) {
    // L2はここが本丸: handed_over 以外は「教え返しへ渡せなかった授業」。
    parts.push(`reason=${metrics.loop_reason}`, `passes=${metrics.passes ?? 0}`);
  }
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
