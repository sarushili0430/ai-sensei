import {
  type CurriculumLocale,
  findTopic,
  isKnownTopicId,
  suggestTopics,
  topicsFor,
} from "@ai-sensei/curriculum";
import { formatBullets, getPrompt, renderPrompt } from "@ai-sensei/prompts";
import { z } from "zod";

/**
 * ノート写真の解析(Vision LLM)。
 *
 * ここが「写真に写っている内容」の側のガードレールを作る工程。
 * 出力のtopic_idはこの時点でカリキュラム照合し、通ったものだけを
 * セッションの許可リストにする。
 *
 * カリキュラムは**ロケールごとに違う**(日本は数学I〜C、海外は Algebra 1〜)。
 * 解析器に渡す一覧も、キーワード推定のフォールバックも、セッションの
 * ロケールで絞る。混ぜると、英語のノートに「数学II / 図形と方程式」という
 * チップが出てしまう。
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
  analyze(input: {
    image: ArrayBuffer;
    contentType: string;
    /** どの課程のトピックに対応づけるか。省略時は日本の課程。 */
    locale?: CurriculumLocale;
  }): Promise<PhotoAnalysis>;
};

/** Vision API(Anthropic Messages)が受け取れる画像形式。これ以外は400が返る。 */
const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/**
 * 画像の形式を決める。
 *
 * multipartの申告(`File.type`)は当てにならない。Flutterの MultipartFile は
 * 既定で `application/octet-stream` を送ってくるので、それをそのまま
 * media_type に流すと Vision API が400を返し、500として表に出てしまう。
 *
 * 中身の先頭バイトで判定し、決められないときだけ申告を見る(許可リストに
 * 載っているものだけ)。どちらでも決まらなければ null を返し、呼び出し側で
 * 「読み取れなかった写真」として扱う。
 */
export function detectImageMediaType(
  image: ArrayBuffer,
  declared?: string | null,
): (typeof SUPPORTED_MEDIA_TYPES)[number] | null {
  const bytes = new Uint8Array(image, 0, Math.min(image.byteLength, 12));

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // GIF: "GIF8"
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  // WebP: "RIFF" + 4バイトの長さ + "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  const normalized = declared?.split(";")[0]?.trim().toLowerCase();
  return SUPPORTED_MEDIA_TYPES.find((type) => type === normalized) ?? null;
}

/** その課程のカリキュラムマップを、プロンプトに貼れる形に畳む。 */
export function curriculumDigest(locale: CurriculumLocale = "ja"): string {
  return topicsFor(locale)
    .map((topic) => `- ${topic.id} | ${topic.course} / ${topic.unit} / ${topic.topic}`)
    .join("\n");
}

export function photoAnalysisPrompt(locale: CurriculumLocale = "ja"): string {
  return renderPrompt(getPrompt("photo_analysis", locale), {
    curriculum_digest: curriculumDigest(locale),
  });
}

/**
 * LLMが返したtopic_idを照合し、許可リストを作る(ガードレール1段目)。
 * 未知のIDは捨て、それでも空なら写真テキストからのキーワード推定にフォールバックする。
 *
 * 照合はロケールでも絞る。日本語のプロンプトに載っていない `A1-...` が返って
 * きたら、それは解析器が別の課程の記憶で答えているので通さない。
 */
export function resolveDetectedTopics(
  analysis: PhotoAnalysis,
  locale: CurriculumLocale = "ja",
): {
  topicIds: string[];
  droppedIds: string[];
} {
  const droppedIds: string[] = [];
  const topicIds: string[] = [];
  const inCurriculum = new Set(topicsFor(locale).map((topic) => topic.id));

  for (const entry of analysis.topics) {
    if (isKnownTopicId(entry.topic_id) && inCurriculum.has(entry.topic_id)) {
      topicIds.push(entry.topic_id);
    } else {
      droppedIds.push(entry.topic_id);
    }
  }

  if (topicIds.length === 0 && analysis.is_math_note) {
    const haystack = [analysis.summary, ...analysis.visible_work, ...analysis.question_seeds].join(
      " ",
    );
    topicIds.push(...suggestTopics(haystack, 3, { locale }).map((topic) => topic.id));
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

/** systemと同じ言語で頼む。日本語で頼むと、英語のプロンプトでも日本語のsummaryが返る。 */
const analysisInstruction: Record<CurriculumLocale, string> = {
  ja: "このノートを解析してJSONだけを返してください。",
  en: "Analyze these notes and return the JSON only.",
};

export type AnthropicAnalyzerOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** Anthropic Messages API を叩くVision解析器。 */
export function createAnthropicAnalyzer(options: AnthropicAnalyzerOptions): PhotoAnalyzer {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";

  return {
    async analyze({ image, contentType, locale = "ja" }) {
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
          system: photoAnalysisPrompt(locale),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: contentType, data: toBase64(image) },
                },
                { type: "text", text: analysisInstruction[locale] },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        // 本文を捨てると「500だった」しか残らず、鍵切れ・過負荷・画像が大きすぎるの
        // どれなのか分からなくなる。長さだけ切って、理由をエラーに載せる。
        const detail = await response.text().catch(() => "");
        throw new Error(`vision APIが失敗しました: ${response.status} ${detail.slice(0, 300)}`);
      }

      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
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
