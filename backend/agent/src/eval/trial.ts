import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardStepSchema, localeSchema } from "@ai-sensei/contract";
import { z } from "zod";

/**
 * 試行1回ぶんの一次資料。**AI・人間・tuner が同じファイルを読む。**
 *
 * ここに全部入れる理由は、あとから増える読み手がそれぞれ別の再現手段を
 * 持たないようにするため:
 *
 *   - `system_prompt` … 本文まるごと。どのプロンプト版で測ったかが
 *     `prompt_sha256` だけだと**復元できない**(生成物は git に入らない場合がある)
 *   - `envelopes` … `boardChannelMessageSchema` を通った封筒の生JSON。
 *     tuner の `/debug` にそのまま貼れる形で、**受信側から見た事実**はこれだけ
 *   - `rejections` … 直さずに数えるのが目的なので、理由と指示文まで残す
 *   - `metrics` … `score.ts` が埋める。**保存後でも再計算できる**ように、
 *     材料(turns / rejections / meta)は全部このファイルの中にある
 *
 * ファイル名は `<scenario_id>.<locale>.t<N>.json`。**既にあれば走らせない**
 * (`docs/figeval` と同じ。途中で止めても続きから走る = 実LLMの支払いを捨てない)。
 */
export const trialSchemaVersion = 1;

/** 授業の列。`senpai.ts` の `LessonTurn` を保存できる形にしたもの。 */
const lessonTurnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), step: boardStepSchema }).strict(),
  z.object({ kind: z.literal("student"), text: z.string() }).strict(),
]);

/**
 * 落ちた手順の記録。`board.ts` の `BoardStepRejection` に対応する。
 *
 * `reason` を enum で書き写さない。あちらは LaTeX の理由(`latexRejectionGuidanceByLocale`
 * の鍵)を含む合併型で、guardrail が理由を1つ足すたびに**保存済みの試行が
 * 読めなくなる**。評価の集計は理由を**文字列の鍵**として数えるだけなので、
 * ここは開いた語彙にしておく。
 */
const rejectionSchema = z
  .object({
    index: z.number().int().min(0),
    kind: z.enum(["latex", "syntax", "schema", "figure"]),
    reason: z.string(),
    detail: z.string(),
    guidance: z.string(),
    raw: z.unknown(),
  })
  .strict();

/**
 * 決定的スコアラーの出力。**スキーマはここ(レコード側)に置く。**
 *
 * `score.ts` に zod を置くと、保存の検証(trial.ts)が採点(score.ts)を
 * 実行時に必要とすることになり、依存が逆向きになる
 * (`score.ts` は `trial.ts` の型だけを読む純関数でいてほしい)。
 */
export const trialMetricsSchema = z
  .object({
    ok: z.boolean(),
    steps_total: z.number().int().min(0),
    rejections_total: z.number().int().min(0),
    rejections_by_reason: z.record(z.string(), z.number().int().min(0)),
    wrote_on_board: z.boolean(),
    board_null_ratio: z.number().min(0).max(1),
    speech_len_max: z.number().int().min(0),
    speech_len_mean: z.number().min(0),
    speech_near_limit: z.number().int().min(0),
    tex_len_max: z.number().int().min(0),
    tex_over_60: z.number().int().min(0),
    awaits_declared: z.number().int().min(0),
    awaits_inferred_only: z.number().int().min(0),
    last_step: z.enum(["teach_back", "awaits_student", "neither", "none"]),
    time_to_first_step_ms: z.number().int().min(0).optional(),
    duration_ms: z.number().int().min(0),
    loop_reason: z.enum(["handed_over", "completed", "interrupted", "error", "budget"]).optional(),
    passes: z.number().int().min(0).optional(),
    student_turns: z.number().int().min(0).optional(),
    silence_markers: z.number().int().min(0).optional(),
    teach_back_turns: z.number().int().min(0).optional(),
    teach_back_closed: z.boolean().optional(),
    karte_holes: z.number().int().min(0).optional(),
    karte_said_well: z.number().int().min(0).optional(),
  })
  .strict();
export type TrialMetrics = z.infer<typeof trialMetricsSchema>;

export const trialMetaSchema = z
  .object({
    schema_version: z.literal(trialSchemaVersion),
    scenario_id: z.string().min(1),
    locale: localeSchema,
    /** L1(板書1パス)か L2(授業の往復)か。 */
    stage: z.enum(["board", "loop"]),
    trial: z.number().int().positive(),
    model: z.string().min(1),
    started_at: z.string().min(1),
    duration_ms: z.number().int().min(0),
    /** system本文の sha256。**どのプロンプト版で測ったか**の札。 */
    prompt_sha256: z.string().length(64),
    /**
     * 最初の手順が配送されるまで。**`duration_ms` と同じ「測った値」なので meta に置く**
     * (`metrics` は材料から導ける値だけにしておきたい。ここだけは実行時にしか取れない)。
     * 手順が1つも出なかった試行には無い。
     */
    time_to_first_step_ms: z.number().int().min(0).optional(),
    /** L2のみ。生徒シミュレータのペルソナ。 */
    persona: z.string().min(1).optional(),
  })
  .strict();
export type TrialMeta = z.infer<typeof trialMetaSchema>;

export const trialRecordSchema = z
  .object({
    meta: trialMetaSchema,
    system_prompt: z.string().min(1),
    turns: z.array(lessonTurnSchema),
    /** `boardChannelMessageSchema` を通った封筒。ここでは形を見ない(通ったものしか来ない)。 */
    envelopes: z.array(z.unknown()),
    rejections: z.array(rejectionSchema),
    /**
     * 配送の終わり方。L2は `runLessonLoop` の `reason`、L1は `append()` の
     * `BoardCloseReason`(`LessonLoopReason` の部分集合)。
     * L1でも残すのは、**「手順は出たが途中で切れた」を他に記録する場所が無い**から。
     */
    loop: z
      .object({
        reason: z.enum(["handed_over", "completed", "interrupted", "error", "budget"]),
        passes: z.number().int().min(0),
        step_count: z.number().int().min(0),
        opened: z.boolean(),
      })
      .strict()
      .optional(),
    teach_back: z
      .object({
        messages: z.array(
          z.object({ role: z.enum(["senpai", "student"]), text: z.string() }).strict(),
        ),
        closed_by_pattern: z.boolean(),
      })
      .strict()
      .optional(),
    karte: z.unknown().optional(),
    /** 実行が例外で落ちたときの1行。**部分レコードでも保存する**(下の `saveTrial`)。 */
    error: z.string().optional(),
    metrics: trialMetricsSchema.optional(),
    /** Stage B のジャッジ結果。形はそちらが決めるので、ここでは触らない。 */
    judge: z.unknown().optional(),
  })
  .strict();
export type TrialRecord = z.infer<typeof trialRecordSchema>;

/**
 * run 1回ぶんの札。**プロンプトの sha256 を run 単位で残す**のが本題で、
 * これが無いと2つの run を並べたときに「同じプロンプトを2回測っただけ」なのか
 * 「編集の前後」なのかが分からない(Stage B の `compareRuns` が最初に見る値)。
 */
export const runManifestSchema = z
  .object({
    schema_version: z.literal(trialSchemaVersion),
    stage: z.enum(["board", "loop"]),
    /** **最初の**起動時刻。再開しても書き換えない。 */
    created_at: z.string().min(1),
    model: z.string().min(1),
    /** 最後の起動の引数。再開の仕方まで含めて残す。 */
    argv: z.array(z.string()),
    /** `<scenario_id>.<locale>` → system本文の sha256。再開のたびに足す。 */
    prompt_sha256: z.record(z.string(), z.string().length(64)),
  })
  .strict();
export type RunManifest = z.infer<typeof runManifestSchema>;

/** どのプロンプト版で測ったか。**本文そのもの**から取る(ファイルの日付では追えない)。 */
export function promptSha256(system: string): string {
  return createHash("sha256").update(system, "utf8").digest("hex");
}

export function trialFileName(input: {
  scenario_id: string;
  locale: string;
  trial: number;
}): string {
  return `${input.scenario_id}.${input.locale}.t${input.trial}.json`;
}

export function trialPath(
  runDir: string,
  input: { scenario_id: string; locale: string; trial: number },
): string {
  return join(runDir, trialFileName(input));
}

/**
 * その試行はもう走っているか。**再開の判定はファイルの有無だけで決める。**
 *
 * 中身を読んで「失敗しているから撮り直す」とはしない — 失敗した試行も
 * 一次資料(どのプロンプトで何が壊れたか)で、消すと同じ失敗をもう一度
 * 実LLMで買うことになる。撮り直したいときは `--out` を変えるか、
 * そのファイルを手で消す。
 */
export function trialExists(
  runDir: string,
  input: { scenario_id: string; locale: string; trial: number },
): boolean {
  return existsSync(trialPath(runDir, input));
}

export function ensureRunDir(runDir: string): string {
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

/** 検証してから書く。**壊れたレコードを残すと、集計の側で気づけない。** */
export function saveTrial(runDir: string, record: TrialRecord): string {
  const validated = trialRecordSchema.parse(record);
  ensureRunDir(runDir);
  const path = trialPath(runDir, validated.meta);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return path;
}

export function readTrial(path: string): TrialRecord {
  return trialRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * run ディレクトリの試行を全部読む。**読めないファイルは名前を出して落とす。**
 * 黙って飛ばすと、集計の分母が静かに減った状態で before/after を比べてしまう。
 *
 * 並びは**試行番号を数として**そろえる。ファイル名順にすると `t10` が `t2` の
 * 前に来て、レポートの行が試行の順に読めなくなる。
 */
export function loadTrials(runDir: string): TrialRecord[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((name) => name.endsWith(".json") && name !== runManifestFileName)
    .sort()
    .map((name) => {
      try {
        return readTrial(join(runDir, name));
      } catch (error) {
        throw new Error(
          `試行レコードが読めません: ${name} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    })
    .sort(
      (a, b) =>
        a.meta.scenario_id.localeCompare(b.meta.scenario_id) ||
        a.meta.locale.localeCompare(b.meta.locale) ||
        a.meta.trial - b.meta.trial,
    );
}

export const runManifestFileName = "run.json";

export function runManifestPath(runDir: string): string {
  return join(runDir, runManifestFileName);
}

export function readRunManifest(runDir: string): RunManifest | undefined {
  const path = runManifestPath(runDir);
  if (!existsSync(path)) return undefined;
  return runManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * `run.json` を書く。**既にあれば混ぜる。**
 *
 * 再開のときに上書きすると、前回のシナリオの `prompt_sha256` が消える —
 * `--scenario` を絞って再開しただけで、run 全体が「どのプロンプトで
 * 測ったか分からない run」に化ける。作成時刻も最初の起動のものを残す。
 */
export function saveRunManifest(
  runDir: string,
  manifest: Omit<RunManifest, "schema_version">,
): RunManifest {
  ensureRunDir(runDir);
  const previous = readRunManifest(runDir);
  const merged = runManifestSchema.parse({
    schema_version: trialSchemaVersion,
    ...manifest,
    created_at: previous?.created_at ?? manifest.created_at,
    prompt_sha256: { ...previous?.prompt_sha256, ...manifest.prompt_sha256 },
  });
  writeFileSync(runManifestPath(runDir), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}
