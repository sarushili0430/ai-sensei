import { z } from "zod";

/**
 * workers/api が LiveKit トークンの metadata に載せた会話文脈。
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
    /** すでに整形済みのMarkdown断片。プロンプトにそのまま貼る。 */
    visible_work: z.string().default("(なし)"),
    question_seeds: z.string().default("(なし)"),
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
 * **落ちたら会話を始めない。** 文脈なしで後輩を喋らせると、
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
  return parsed.data;
}

/** 会話の残り時間(秒)。プロンプトに渡して、締めに入る判断をさせる。 */
export function remainingSeconds(context: SessionContext, startedAt: Date, now: Date): number {
  const elapsed = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
  return Math.max(0, context.max_seconds - elapsed);
}
