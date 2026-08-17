import { basename } from "node:path";
import { type JudgeVerdict, countVerdicts, readTrialJudge } from "./judge.ts";
import { rubrics } from "./rubrics.ts";
import { scenarioKey } from "./scenario.ts";
import { scoreTrial } from "./score.ts";
import {
  type RunManifest,
  type TrialMetrics,
  type TrialRecord,
  loadTrials,
  readRunManifest,
} from "./trial.ts";

/**
 * 要約と before/after の比較。**Markdown の文字列を返すだけ**(書き出しはCLI)。
 *
 * 読み方の約束を3つ、表の形に埋め込んである:
 *
 *   1. **`error` 付きの試行は分母から外す。**あれはハーネス側の事故
 *      (通信・封筒の契約違反)で、モデルの成績ではない。外したことは
 *      脚注に件数で残す — 黙って外すと、before と after が違う母数のまま並ぶ。
 *   2. **プロンプトの sha256 が同じ2つの run は比較しない。**同じプロンプトを
 *      2回測っただけなので、差はぜんぶ実LLMのばらつき。気づかないまま
 *      「改善した」と読むのがいちばん高くつくので、表の前に警告を置く。
 *   3. **ジャッジ未実行の run でも読める。**決定的スコアラーの列だけで表を出し、
 *      ジャッジの列は `-` にする(鍵の要らない `report` を、判定の有無で
 *      落とさないため)。
 *
 * 指標は `metrics` が入っていればそれを使い、無ければ `scoreTrial` で
 * **その場で数え直す**(`score.ts` を純関数にしてあるのはこのため。指標を1本
 * 足したときに、過去の run を撮り直さずに読み直せる)。
 */

/** 悪化したセルの印。**目で1回走らせて見つけられる**ことだけが要件。 */
export const worseMark = "▲";

export type Cell = {
  /** 比較に使う数。`undefined` = その run では測れていない(L2の列をL1で見たときなど)。 */
  value: number | undefined;
  /** 表に出す形。率は `2/3`、平均は `0.7`。 */
  text: string;
};

export type Metric = {
  label: string;
  /** 良い向き。`none` は差分に印を付けない(手順数のように、多寡が良し悪しでない列)。 */
  better: "higher" | "lower" | "none";
  measure: (rows: readonly TrialRecord[]) => Cell;
};

const missing: Cell = { value: undefined, text: "-" };

function rate(rows: readonly TrialRecord[], hit: (metrics: TrialMetrics) => boolean): Cell {
  if (rows.length === 0) return missing;
  const count = rows.filter((row) => hit(metricsOf(row))).length;
  return { value: count / rows.length, text: `${count}/${rows.length}` };
}

/**
 * 分母を絞った率。**その欄を持つ試行だけで数える。**
 *
 * `loop_reason` は L2 の試行にしか無い。L1 を分母に入れると「渡せた率」が
 * stage の混ざり具合で動く数字になり、プロンプトの差が読めなくなる。
 */
function rateWhen(
  rows: readonly TrialRecord[],
  applies: (metrics: TrialMetrics) => boolean,
  hit: (metrics: TrialMetrics) => boolean,
): Cell {
  const target = rows.filter((row) => applies(metricsOf(row)));
  if (target.length === 0) return missing;
  const count = target.filter((row) => hit(metricsOf(row))).length;
  return { value: count / target.length, text: `${count}/${target.length}` };
}

/** 1試行あたりの平均。小数第1位まで(桁が揺れると表が読めない)。 */
function mean(rows: readonly TrialRecord[], pick: (metrics: TrialMetrics) => number): Cell {
  if (rows.length === 0) return missing;
  const total = rows.reduce((sum, row) => sum + pick(metricsOf(row)), 0);
  const value = total / rows.length;
  return { value, text: value.toFixed(1) };
}

/**
 * ジャッジで1件以上 fail が付いた試行の率。**分母は判定できた試行だけ。**
 *
 * fail の件数(ルール数)ではなく試行数で数えるのは、run ごとに判定した試行数が
 * 違っても並べられるようにするため。どのルールで落ちたかは要約の
 * 「ジャッジ」の表(ルール別)で読む。
 */
function judgeFailRate(rows: readonly TrialRecord[]): Cell {
  const judged = rows.flatMap((row) => {
    const judge = readTrialJudge(row);
    return judge === undefined ? [] : [judge];
  });
  if (judged.length === 0) return missing;
  const failed = judged.filter((judge) => judge.rules.some((rule) => rule.verdict === "fail"));
  return { value: failed.length / judged.length, text: `${failed.length}/${judged.length}` };
}

/**
 * 表の列。**要約と比較で同じ定義を使う。**
 *
 * 列を2組持つと、比較で悪化していた指標が要約に無い(またはその逆)という
 * 読み方になり、どちらを信じるかの判断が要る表になる。
 */
export const reportMetrics: readonly Metric[] = [
  { label: "ok", better: "higher", measure: (rows) => rate(rows, (m) => m.ok) },
  { label: "手順", better: "none", measure: (rows) => mean(rows, (m) => m.steps_total) },
  {
    label: "落ちた手順",
    better: "lower",
    measure: (rows) => mean(rows, (m) => m.rejections_total),
  },
  {
    label: "教え返しへ",
    better: "higher",
    measure: (rows) => rate(rows, (m) => m.last_step === "teach_back"),
  },
  {
    label: "渡した(L2)",
    better: "higher",
    measure: (rows) =>
      rateWhen(
        rows,
        (m) => m.loop_reason !== undefined,
        (m) => m.loop_reason === "handed_over",
      ),
  },
  {
    label: "speech>100",
    better: "lower",
    measure: (rows) => mean(rows, (m) => m.speech_near_limit),
  },
  { label: "tex>60", better: "lower", measure: (rows) => mean(rows, (m) => m.tex_over_60) },
  {
    label: "awaits推測のみ",
    better: "lower",
    measure: (rows) => mean(rows, (m) => m.awaits_inferred_only),
  },
  { label: "judge fail", better: "lower", measure: judgeFailRate },
];

/** 保存済みの指標を使い、無ければ数え直す。理由はファイル先頭の説明。 */
function metricsOf(record: TrialRecord): TrialMetrics {
  return record.metrics ?? scoreTrial(record);
}

function keyOf(record: TrialRecord): string {
  return scenarioKey({ id: record.meta.scenario_id, locale: record.meta.locale });
}

/** シナリオ(`<id>.<locale>`)ごとの並び。**キーの順はソートして決定的にする。** */
function groupByScenario(records: readonly TrialRecord[]): Map<string, TrialRecord[]> {
  const groups = new Map<string, TrialRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    const rows = groups.get(key);
    if (rows === undefined) groups.set(key, [record]);
    else rows.push(record);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/** ハーネス側の事故。**分母から外す**(脚注に件数と名前を残す)。 */
function isAccident(record: TrialRecord): boolean {
  return record.error !== undefined;
}

function trialLabel(record: TrialRecord): string {
  return `${keyOf(record)} t${record.meta.trial}`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/**
 * run 1本の要約。シナリオ × 指標と、ジャッジのルール別集計。
 *
 * ジャッジが1件も無い run でも表は出る(ジャッジの列は `-`)。
 */
export function summarizeRun(runDir: string): string {
  const all = loadTrials(runDir);
  if (all.length === 0)
    return `# eval run: ${basename(runDir)}\n\n試行レコードがありません: ${runDir}`;

  const manifest = readRunManifest(runDir);
  const accidents = all.filter((record) => isAccident(record));
  const groups = groupByScenario(all.filter((record) => !isAccident(record)));
  const judged = all.filter((record) => readTrialJudge(record) !== undefined);

  const rows = [...groups].map(([key, records]) => [
    key,
    String(records.length),
    ...reportMetrics.map((metric) => metric.measure(records).text),
  ]);

  return [
    `# eval run: ${basename(runDir)}`,
    "",
    ...runFacts(runDir, all, manifest),
    "",
    table(["シナリオ", "試行", ...reportMetrics.map((metric) => metric.label)], rows),
    "",
    ...judgeSection(all),
    ...footnotes(
      accidents.map((record) => trialLabel(record)),
      judged.length,
      all.length,
    ),
  ].join("\n");
}

function runFacts(
  runDir: string,
  records: readonly TrialRecord[],
  manifest: RunManifest | undefined,
): string[] {
  const models = [...new Set(records.map((record) => record.meta.model))];
  return [
    `- 置き場: \`${runDir}\``,
    `- stage: ${[...new Set(records.map((record) => record.meta.stage))].join(", ")} / model: ${models.join(", ")}`,
    ...(manifest === undefined ? [] : [`- 作成: ${manifest.created_at}`]),
    `- 試行: ${records.length} 件`,
    ...promptFacts(records).map((line) => `- ${line}`),
  ];
}

/**
 * どのプロンプト版で測ったか。**札は試行のレコードから取る**(`run.json` ではなく)。
 *
 * `run.json` は `--scenario` を絞って再開すると混ざるが、`meta.prompt_sha256` は
 * その試行を走らせたときの本文そのものの札。**同じシナリオで札が2つある run は、
 * 途中でプロンプトが変わっている** = その run 内の試行を1つの母数として
 * 読めないので、そこも警告に出す。
 */
function promptFacts(records: readonly TrialRecord[]): string[] {
  return [...groupByScenario(records)].map(([key, rows]) => {
    const shas = [...new Set(rows.map((row) => row.meta.prompt_sha256))];
    const shown = shas.map((sha) => sha.slice(0, 8)).join(", ");
    return shas.length === 1
      ? `プロンプト ${key}: ${shown}`
      : `プロンプト ${key}: ${shown} — **警告: run の途中でプロンプトが変わっています**`;
  });
}

/** ルール別の集計と、検出器との食い違い。判定が1件も無ければ促す1行だけ。 */
function judgeSection(records: readonly TrialRecord[]): string[] {
  const judges = records.flatMap((record) => {
    const judge = readTrialJudge(record);
    return judge === undefined ? [] : [{ record, judge }];
  });

  if (judges.length === 0) {
    return ["## ジャッジ", "", "判定がありません(`eval judge <runDir>` で付きます)。", ""];
  }

  const rows = rubrics.map((rubric) => {
    const verdicts = judges.flatMap((entry) =>
      entry.judge.rules.filter((rule) => rule.rule_id === rubric.id),
    );
    const count = (verdict: JudgeVerdict): string =>
      String(verdicts.filter((rule) => rule.verdict === verdict).length);
    return [
      `${rubric.code} \`${rubric.id}\``,
      count("pass"),
      count("fail"),
      count("not_applicable"),
      count("error"),
    ];
  });

  const mismatches = judges.flatMap((entry) =>
    entry.judge.detector_mismatches.map((mismatch) => ({
      ...mismatch,
      at: trialLabel(entry.record),
    })),
  );
  const byDirection = (direction: string): number =>
    mismatches.filter((mismatch) => mismatch.direction === direction).length;

  return [
    "## ジャッジ",
    "",
    `判定した試行: ${judges.length} 件`,
    ...(judges.some((entry) => entry.judge.error !== undefined)
      ? [
          `**警告: 応答が読めなかった試行が ${judges.filter((entry) => entry.judge.error !== undefined).length} 件あります**(判定は error。試行のJSONの \`judge\` を消せば聞き直します)`,
        ]
      : []),
    "",
    table(["ルール", "pass", "fail", "n/a", "error"], rows),
    "",
    "### 検出器との食い違い",
    "",
    `\`asksForTeachBack()\` との差: judge_only ${byDirection("judge_only")} 件 / detector_only ${byDirection("detector_only")} 件`,
    ...(mismatches.length === 0
      ? []
      : [
          "",
          // 全部は出さない。ここは「見に行く場所」を指す索引で、正本は試行のJSON。
          ...mismatches
            .slice(0, mismatchExamples)
            .map(
              (mismatch) =>
                `- ${mismatch.direction} (${mismatch.at}${mismatch.step_index === undefined ? "" : ` step ${mismatch.step_index}`}): 「${mismatch.speech}」`,
            ),
          ...(mismatches.length > mismatchExamples
            ? [`- ほか ${mismatches.length - mismatchExamples} 件(試行のJSONの \`judge\` を読む)`]
            : []),
        ]),
    "",
  ];
}

/** 食い違いの例を出す件数。 */
const mismatchExamples = 5;

/**
 * 脚注。**分母から外したものを、外した数だけ言う。**
 *
 * 先頭を空行から始めるのは Markdown の都合 — 直前の行に `---` が続くと、
 * その行が見出し(setext)になって表の説明文が化ける。
 */
function footnotes(
  accidentLabels: readonly string[],
  judgedCount: number,
  total: number,
): string[] {
  const lines: string[] = [];
  if (accidentLabels.length > 0) {
    lines.push(
      `- ハーネス側の事故で分母から外した試行: ${accidentLabels.length} 件(${accidentLabels.join(", ")})`,
    );
  }
  if (judgedCount < total) {
    lines.push(`- ジャッジ済み: ${judgedCount}/${total} 件(残りはジャッジの列に入っていません)`);
  }
  return lines.length === 0 ? [] : ["", "---", "", ...lines];
}

/**
 * 2つの run を並べる。**行=シナリオ、セル=`base → cand`**、悪化に {@link worseMark}。
 *
 * 最初に見るのはプロンプトの札(`prompt_sha256`)。同じなら差はぜんぶ
 * 実LLMのばらつきなので、表より前に警告を置く。モデルが違うときも同じ
 * (それはプロンプトの差ではない)。
 */
export function compareRuns(baseDir: string, candDir: string): string {
  const base = loadTrials(baseDir);
  const candidate = loadTrials(candDir);

  const baseGroups = groupByScenario(base.filter((record) => !isAccident(record)));
  const candGroups = groupByScenario(candidate.filter((record) => !isAccident(record)));
  const keys = [...new Set([...baseGroups.keys(), ...candGroups.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );

  const rows = keys.map((key) => {
    const left = baseGroups.get(key) ?? [];
    const right = candGroups.get(key) ?? [];
    return [
      key,
      `${left.length} → ${right.length}`,
      ...reportMetrics.map((metric) => diffCell(metric, left, right)),
    ];
  });

  return [
    "# eval compare",
    "",
    `- base: \`${baseDir}\`(${base.length} 試行)`,
    `- cand: \`${candDir}\`(${candidate.length} 試行)`,
    "",
    ...warnings(base, candidate),
    table(["シナリオ", "試行", ...reportMetrics.map((metric) => metric.label)], rows),
    "",
    `${worseMark} は悪化したセル。判定できない列は \`-\`(その run に材料が無い)。`,
    ...footnotes(
      // **どちらの run で落ちたか**まで書く。件数だけでは、外した試行を探しに行けない。
      [
        ...base
          .filter((record) => isAccident(record))
          .map((record) => `base ${trialLabel(record)}`),
        ...candidate
          .filter((record) => isAccident(record))
          .map((record) => `cand ${trialLabel(record)}`),
      ],
      [...base, ...candidate].filter((record) => readTrialJudge(record) !== undefined).length,
      base.length + candidate.length,
    ),
  ].join("\n");
}

function diffCell(
  metric: Metric,
  base: readonly TrialRecord[],
  candidate: readonly TrialRecord[],
): string {
  const left = metric.measure(base);
  const right = metric.measure(candidate);
  const worse =
    left.value !== undefined &&
    right.value !== undefined &&
    ((metric.better === "higher" && right.value < left.value) ||
      (metric.better === "lower" && right.value > left.value));
  return `${left.text} → ${right.text}${worse ? ` ${worseMark}` : ""}`;
}

/** 比較そのものが成立していないときの警告。**表より前に置く。** */
function warnings(base: readonly TrialRecord[], candidate: readonly TrialRecord[]): string[] {
  const lines: string[] = [];

  if (base.length === 0) lines.push("**警告: base に試行がありません**");
  if (candidate.length === 0) lines.push("**警告: cand に試行がありません**");

  const candidateShas = shaByScenario(candidate);
  const same = [...shaByScenario(base)].filter(([key, sha]) => candidateShas.get(key) === sha);
  if (same.length > 0) {
    lines.push(
      `**警告: プロンプトの sha256 が同じシナリオがあります**(同じプロンプトを2回測っています。差は実LLMのばらつきです): ${same
        .map(([key]) => key)
        .join(", ")}`,
    );
  }

  const models = (records: readonly TrialRecord[]): string =>
    [...new Set(records.map((record) => record.meta.model))].sort().join(", ");
  if (base.length > 0 && candidate.length > 0 && models(base) !== models(candidate)) {
    lines.push(
      `**警告: モデルが違います**(${models(base)} → ${models(candidate)})。この差はプロンプトの差ではありません。`,
    );
  }

  return lines.length === 0 ? [] : [...lines, ""];
}

/**
 * シナリオごとのプロンプトの札。**run の中で札が1つに決まらないシナリオは外す** —
 * 途中でプロンプトが変わった run は「同じか違うか」を言える相手ではない
 * (要約のほうが `promptFacts` で警告を出す)。
 */
function shaByScenario(records: readonly TrialRecord[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, rows] of groupByScenario(records)) {
    const shas = [...new Set(rows.map((row) => row.meta.prompt_sha256))];
    const [only] = shas;
    if (shas.length === 1 && only !== undefined) found.set(key, only);
  }
  return found;
}
