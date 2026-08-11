import {
  type PlanSessionMetadata,
  type SessionMetadata,
  planSessionMetadataSchema,
  sessionMetadataSchema,
} from "@ai-sensei/contract";
import { type CurriculumSubject, subjectOfTopicId } from "@ai-sensei/curriculum";
import { formatBullets } from "@ai-sensei/prompts";

/**
 * backend/api が LiveKit トークンの metadata に載せた会話文脈。
 *
 * 「写真の解釈」と「触れてよいトピック」がここに入っている。
 * 別チャネルで渡すと、トークンと文脈がずれたセッションが生まれうるので、
 * トークンと同じ経路で運ぶ。
 *
 * 受信側だけで形を定義すると、APIとの改名・必須化のずれを既定値で隠してしまう。
 * そのため検証は共有契約そのものを使い、agent固有の整形は検証後にだけ行う。
 */
export const sessionContextSchema = sessionMetadataSchema;

export type SessionContext = SessionMetadata;
export type PlanSessionContext = PlanSessionMetadata;
export type AgentContext = SessionContext | PlanSessionContext;

export class InvalidSessionContextError extends Error {}

/**
 * この授業の教科。**板書に使える要素と、同梱する音声補正ヒントを決める。**
 *
 * metadata に教科の欄は無い。`allowed_topic_ids` の接頭辞から引く
 * (ADR 0006 — 課程・言語・教科・学校段階はすべて topic_id ひとつから決まる)。
 * 契約を増やさずに済むので、APIとagentのデプロイ順を気にしなくてよい。
 *
 * 許可トピックが空のセッションは {@link readSessionContext} が弾くので、
 * 先頭は必ずある。それでも引けないときは数学に倒す —
 * 数学しか無かった頃と同じ挙動で、少なくとも今までどおりに動く。
 */
export function subjectOf(context: Pick<SessionContext, "allowed_topic_ids">): CurriculumSubject {
  const [first] = context.allowed_topic_ids;
  return (first ? subjectOfTopicId(first) : undefined) ?? "math";
}

/**
 * 参加者のmetadataを読む。
 * **落ちたら会話を始めない。** 文脈なしで先輩を喋らせると、
 * 写真と関係ない一般論を聞き始めてしまう。
 */
export function readSessionContext(metadata: string | undefined | null): SessionContext {
  if (!metadata) {
    throw new InvalidSessionContextError("参加者のmetadataが空です");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(metadata);
  } catch {
    throw new InvalidSessionContextError("参加者のmetadataがJSONではありません");
  }

  const parsed = sessionContextSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidSessionContextError(`metadataの形式が不正です: ${parsed.error.message}`);
  }
  if (parsed.data.allowed_topic_ids.length === 0) {
    throw new InvalidSessionContextError("許可トピックが空のセッションは開始できません");
  }
  return withLocalePlaceholders(parsed.data);
}

/**
 * 空欄に**会話の言語で**「なし」を入れる。
 *
 * 残っているのは `question_seeds` だけ。`problem_text` と `visible_work` は
 * 契約が `.min(1)` を保証していて、**プレースホルダも契約側が入れてくる**ので
 * こちらでは触らない(埋める場所が2つあると文言がずれる)。
 *
 * `question_seeds` は欄そのものは必須だが、契約側が空文字を許しているぶん、
 * 検証後にここで整える。空の節が残るとモデルが「読めなかった」と解釈して、
 * 写真の話を推測で埋めにいく。
 * `formatBullets([])` を借りているのは、**文言を1か所に保つ**ため —
 * backend/api が同じ関数で組み立てているので、ここで別の文字列を書かないかぎりずれない。
 */
function withLocalePlaceholders(context: SessionContext): SessionContext {
  if (context.question_seeds.trim() !== "") return context;
  return { ...context, question_seeds: formatBullets([], context.locale) };
}

/**
 * 文脈が来る経路は2つある。**最初に読めたほうを使う。**
 *
 * - 参加者のmetadata(トークンの `metadata` クレーム)
 * - ジョブのmetadata(明示ディスパッチのとき、`roomConfig.agents[].metadata`)
 *
 * どちらもAPIが同じ内容を載せるが、ワーカーが名前つきかどうかで
 * 届く経路が変わる。片方しか見ないと、ディスパッチの仕方を変えた瞬間に
 * 「文脈が読めないので黙って切る」に落ちる。
 */
export function resolveSessionContext(
  candidates: readonly (string | undefined | null)[],
): SessionContext {
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return readSessionContext(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new InvalidSessionContextError(
    errors.length > 0 ? errors.join(" / ") : "セッション文脈がどこにも載っていません",
  );
}

/**
 * 授業と計画の封筒を判別して読む。
 *
 * `sessionKinds` を広げて授業schemaをunionにすると、授業に必須の問題文まで任意になる。
 * 入口だけをunionにし、判別後はそれぞれの厳しいschemaを通すことで、計画を足しても
 * 「問題を見ずに教える」経路を再び開けない。
 */
export function readAgentContext(metadata: string | undefined | null): AgentContext {
  if (!metadata) throw new InvalidSessionContextError("参加者のmetadataが空です");
  let raw: unknown;
  try {
    raw = JSON.parse(metadata);
  } catch {
    throw new InvalidSessionContextError("参加者のmetadataがJSONではありません");
  }

  if (isPlanEnvelope(raw)) {
    const parsed = planSessionMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidSessionContextError(`計画metadataの形式が不正です: ${parsed.error.message}`);
    }
    return parsed.data;
  }
  return readSessionContext(metadata);
}

export function resolveAgentContext(
  candidates: readonly (string | undefined | null)[],
): AgentContext {
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return readAgentContext(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new InvalidSessionContextError(
    errors.length > 0 ? errors.join(" / ") : "セッション文脈がどこにも載っていません",
  );
}

function isPlanEnvelope(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "plan";
}

/** 会話の残り時間(秒)。プロンプトに渡して、締めに入る判断をさせる。 */
export function remainingSeconds(
  context: Pick<AgentContext, "max_seconds">,
  startedAt: Date,
  now: Date,
): number {
  const elapsed = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
  return Math.max(0, context.max_seconds - elapsed);
}
