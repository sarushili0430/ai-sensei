import { findTopic, isKnownTopicId, suggestTopics, topics } from "@ai-sensei/curriculum";
import { formatBullets, getPrompt, renderPrompt } from "@ai-sensei/prompts";
import { z } from "zod";

/**
 * ノート写真の解析(Vision LLM)。
 *
 * ここが「写真に写っている内容」の側のガードレールを作る工程。
 * 出力のtopic_idはこの時点でカリキュラム照合し、通ったものだけを
 * セッションの許可リストにする。
 */

export const photoAnalysisSchema = z.object({
  is_math_note: z.boolean(),
  summary: z.string(),
  visible_work: z.array(z.string()).default([]),
  topics: z
    .array(z.object({ topic_id: z.string(), confidence: z.number().min(0).max(1) }))
    .default([]),
  unreadable: z.array(z.string()).default([]),
  question_seeds: z.array(z.string()).default([]),
});
export type PhotoAnalysis = z.infer<typeof photoAnalysisSchema>;

export type PhotoAnalyzer = {
  analyze(input: { image: ArrayBuffer; contentType: string }): Promise<PhotoAnalysis>;
};

/** カリキュラムマップをプロンプトに貼れる形に畳む(全52トピックの要約)。 */
export function curriculumDigest(): string {
  return topics
    .map((topic) => `- ${topic.id} | ${topic.course} / ${topic.unit} / ${topic.topic}`)
    .join("\n");
}

/**
 * 解析プロンプト。カリキュラム52件を畳んだ結果は毎回同じなので、一度だけ組み立てる。
 *
 * ここが**バイト単位で毎回同じ**であることが、下のプロンプトキャッシュの前提。
 * 日付や乱数を混ぜると、キャッシュが一度も当たらないまま書き込み料金だけ払うことになる。
 */
let renderedPrompt: string | undefined;

export function photoAnalysisPrompt(): string {
  renderedPrompt ??= renderPrompt(getPrompt("photo_analysis"), {
    curriculum_digest: curriculumDigest(),
  });
  return renderedPrompt;
}

/**
 * LLMが返したtopic_idを照合し、許可リストを作る(ガードレール1段目)。
 * 未知のIDは捨て、それでも空なら写真テキストからのキーワード推定にフォールバックする。
 */
export function resolveDetectedTopics(analysis: PhotoAnalysis): {
  topicIds: string[];
  droppedIds: string[];
} {
  const droppedIds: string[] = [];
  const topicIds: string[] = [];

  for (const entry of analysis.topics) {
    if (isKnownTopicId(entry.topic_id)) topicIds.push(entry.topic_id);
    else droppedIds.push(entry.topic_id);
  }

  if (topicIds.length === 0 && analysis.is_math_note) {
    const haystack = [analysis.summary, ...analysis.visible_work, ...analysis.question_seeds].join(
      " ",
    );
    topicIds.push(...suggestTopics(haystack, 3).map((topic) => topic.id));
  }

  return { topicIds: [...new Set(topicIds)], droppedIds };
}

export function toDetectedTopicPayload(
  topicIds: readonly string[],
  analysis: PhotoAnalysis,
): { topic_id: string; course: string; unit: string; topic: string; confidence: number }[] {
  const confidenceById = new Map(
    analysis.topics.map((entry) => [entry.topic_id, entry.confidence]),
  );
  return topicIds.flatMap((topicId) => {
    const topic = findTopic(topicId);
    if (!topic) return [];
    return [
      {
        topic_id: topic.id,
        course: topic.course,
        unit: topic.unit,
        topic: topic.topic,
        // キーワード推定にフォールバックした分は、確信度を明示的に低くする
        confidence: confidenceById.get(topicId) ?? 0.4,
      },
    ];
  });
}

/**
 * systemプロンプトのキャッシュ保持時間。
 *
 * 写真解析はセッション開始時に1回だけ走るので、既定の5分では次の解析が来る前に
 * 期限切れになりやすい。切れたまま呼び続けると、書き込み割増(1.25倍)だけを
 * 毎回払うことになって**かえって高くつく**。
 *
 * 1時間だと書き込みは2倍になるが、損益分岐は「1時間に3回」まで下がる。
 * 解析が1時間に3回も来ないうちは "off" のほうが安い。
 */
export type PromptCacheTtl = "5m" | "1h" | "off";

export type AnthropicAnalyzerOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 既定は "1h"。 */
  promptCache?: PromptCacheTtl;
};

/** systemブロックに付けるキャッシュ指定。5分はttlを省略した形が既定値。 */
function cacheControlFor(ttl: PromptCacheTtl): Record<string, unknown> {
  if (ttl === "off") return {};
  if (ttl === "1h") return { cache_control: { type: "ephemeral", ttl: "1h" } };
  return { cache_control: { type: "ephemeral" } };
}

/** Anthropic Messages API を叩くVision解析器。 */
export function createAnthropicAnalyzer(options: AnthropicAnalyzerOptions): PhotoAnalyzer {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const promptCache = options.promptCache ?? "1h";

  return {
    async analyze({ image, contentType }) {
      const response = await doFetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: 1500,
          // キャッシュはプレフィックス一致なので、動かない側(system)を先に置き、
          // 毎回変わる側(写真)はこのブロックより後ろ = messages に置く。
          // ここに写真の要約や日時を混ぜた瞬間にキャッシュは当たらなくなる。
          system: [
            {
              type: "text",
              text: photoAnalysisPrompt(),
              ...cacheControlFor(promptCache),
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: contentType, data: toBase64(image) },
                },
                { type: "text", text: "このノートを解析してJSONだけを返してください。" },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`vision APIが失敗しました: ${response.status}`);
      }

      const payload = (await response.json()) as {
        content?: { type: string; text?: string }[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };

      // キャッシュが当たっているかは、この数字でしか分からない。
      // cache_read が0のまま増えないなら、systemプロンプトが毎回変わっている。
      const usage = payload.usage;
      if (usage) {
        console.log(
          `[photo-analysis] cache=${promptCache}` +
            ` in=${usage.input_tokens ?? 0}` +
            ` cache_write=${usage.cache_creation_input_tokens ?? 0}` +
            ` cache_read=${usage.cache_read_input_tokens ?? 0}` +
            ` out=${usage.output_tokens ?? 0}`,
        );
      }

      const text = payload.content?.find((part) => part.type === "text")?.text ?? "";
      return photoAnalysisSchema.parse(extractJson(text));
    },
  };
}

/** ```json フェンスや前置きが付いて返ってきても拾えるようにする。 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLMの出力にJSONが見つかりません");
  return JSON.parse(candidate.slice(start, end + 1));
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export { formatBullets };
