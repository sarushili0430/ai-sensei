import { formatBullets } from "@ai-sensei/prompts";
import { z } from "zod";

/**
 * backend/api が LiveKit トークンの metadata に載せた会話文脈。
 *
 * 「写真の解釈」と「触れてよいトピック」がここに入っている。
 * 別チャネルで渡すと、トークンと文脈がずれたセッションが生まれうるので、
 * トークンと同じ経路で運ぶ。
 */
export const sessionContextSchema = z
  .object({
    session_id: z.string().min(1),
    locale: z.enum(["ja", "en"]).default("ja"),
    kind: z.enum(["new", "review"]).default("new"),
    /** サーバが強制する会話の上限秒数(無料5分 / Premium15分)。 */
    max_seconds: z.number().int().positive(),
    photo_summary: z.string().default(""),
    /**
     * **問題文。既定値を持たせない。**
     *
     * 契約(`sessionMetadataSchema.problem_text`)が `.min(1)` で、読み取れなかったときも
     * **その言語のプレースホルダ「(問題の写真なし)」が入った状態で届く**。
     * だからここで空を埋める必要はないし、埋めてはいけない — 文言を作る場所が2つあると、
     * `senpai_board.<locale>.md` が名指しで見ている文字列と1文字ずれ、
     * 「推測で組み立てるな」の指示が発火しないまま
     * **先輩が自分で作った問題を教えはじめる**。
     *
     * 欠けて届いたら、それは backend/api と agent の版がずれている。**会話を始めない。**
     */
    problem_text: z.string().min(1),
    /**
     * ノートから読み取れた作業(整形済み)。**既定値を持たせない。**
     *
     * 契約側は3つの状態を区別して送ってくる(箇条書き / 「(なし)」 /
     * 「(ノートの写真なし)」)。ここで空を埋めると
     * **「ノートに何も書いていない生徒」と「ノートを撮らなかった生徒」が同じになり**、
     * 先輩は持っていない生徒に「ノート見せて」と言い出す。
     * 文言は `@ai-sensei/prompts` の `formatVisibleWork()` にしか無い。
     */
    visible_work: z.string().min(1),
    question_seeds: z.string().default(""),
    allowed_topics: z.string().default(""),
    /** ガードレール照合に使う許可リスト。 */
    allowed_topic_ids: z.array(z.string()).default([]),
    is_premium: z.boolean().default(false),
  })
  .passthrough();

export type SessionContext = z.infer<typeof sessionContextSchema>;

export class InvalidSessionContextError extends Error {}

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
 * `question_seeds` は契約側が空を許しているぶん、ここで受ける。空の節が残ると
 * モデルが「読めなかった」と解釈して、写真の話を推測で埋めにいく。
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

/** 会話の残り時間(秒)。プロンプトに渡して、締めに入る判断をさせる。 */
export function remainingSeconds(context: SessionContext, startedAt: Date, now: Date): number {
  const elapsed = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
  return Math.max(0, context.max_seconds - elapsed);
}
