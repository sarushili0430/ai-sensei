import { type SessionProblem, problemTextMaxLength } from "@ai-sensei/contract";
import {
  type CurriculumLocale,
  type SchoolStage,
  type TrackId,
  curricula,
  tracks as curriculumTracks,
  findTopic,
  isKnownTopicId,
  suggestTopics,
  topicLabel,
  topicsForTracks,
  tracksForStage,
} from "@ai-sensei/curriculum";
import { checkProblemText } from "@ai-sensei/guardrail";
import { formatBullets, getPrompt, renderPrompt } from "@ai-sensei/prompts";
import { z } from "zod";

/**
 * Notes photo analysis (Vision LLM).
 *
 * This step builds the guardrail on the "what is in the photo" side. The output
 * topic_ids are matched against the curriculum here, and only those that pass
 * become the session's allow-list.
 *
 * Curricula differ per locale (Japan has Math I-C, elsewhere Algebra 1+). The
 * list handed to the analyser and the keyword-inference fallback are both
 * filtered by the session's locale. Mixing them puts a "Math II / coordinate
 * geometry" chip on an English notebook.
 */

/**
 * The subject in the photo.
 *
 * Replaces `is_math_note: boolean`. A boolean sufficed while math was the only
 * supported subject, but adding English makes "not math" and "unsupported" two
 * different things. Only `other` is out of scope; the rest narrow the curriculum.
 */
export const analysisSubjects = ["math", "english", "other"] as const;
export type AnalysisSubject = (typeof analysisSubjects)[number];

export const photoAnalysisSchema = z.object({
  /** Not defaulting to `other`: a dropped field would fall toward discarding the photo. */
  subject: z.enum(analysisSubjects).default("math"),
  summary: z.string(),
  /**
   * A transcription of the problem itself (plan §0 decision 4, "send the problem
   * and the notes together").
   *
   * Empty string when unreadable. The `""` default lets a session start even if
   * the analyser answers in an old shape - failing the parse here would stop the
   * lesson entirely just because the problem text was unreadable.
   * What to pass to the prompt when empty is the caller's job
   * (`routes/sessions.ts`).
   *
   * The cap is `@ai-sensei/contract`'s `problemTextMaxLength`, and it is not
   * truncated here. Exceeding it means "the whole page was transcribed", and
   * silently taking the first 600 chars would teach a problem cut mid-question.
   */
  problem_text: z.string().default(""),
  visible_work: z.array(z.string()).default([]),
  topics: z
    .array(z.object({ topic_id: z.string(), confidence: z.number().min(0).max(1) }))
    .default([]),
  unreadable: z.array(z.string()).default([]),
  question_seeds: z.array(z.string()).default([]),
});
export type PhotoAnalysis = z.infer<typeof photoAnalysisSchema>;

/** One image passed to the analysis. */
export type PhotoAnalysisImage = { image: ArrayBuffer; contentType: string };

/**
 * What is passed to the analysis. The type states that at least one of the two
 * is always present.
 *
 * It is not an array (`images: [...]`) because the two are not equivalent: notes
 * are stored in R2 and the problem page is not (`contract`'s `sessionPhotoParts`).
 * An array would erase that asymmetry from the type.
 *
 * "Both undefined" is unrepresentable because that is the silent failure: called
 * with no image, the analyser sometimes answers `is_math_note: true` from
 * imagination, and the session starts on a unit that is not in any photo.
 */
export type PhotoAnalyzerInput = { locale?: CurriculumLocale; stage?: SchoolStage } & (
  | { notes: PhotoAnalysisImage; problem?: PhotoAnalysisImage }
  | { notes?: PhotoAnalysisImage; problem: PhotoAnalysisImage }
);

export type PhotoAnalyzer = {
  analyze(input: PhotoAnalyzerInput): Promise<PhotoAnalysis>;
};

/** Image formats the Vision API (Anthropic Messages) accepts. Anything else returns 400. */
const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/**
 * Decides the image format.
 *
 * The multipart claim (`File.type`) is unreliable: Flutter's MultipartFile sends
 * `application/octet-stream` by default, and passing that straight to media_type
 * makes the Vision API return 400, surfacing as a 500.
 *
 * Decide from the leading bytes of the content, falling back to the claim only
 * when undecidable (and only for allow-listed values). If neither decides,
 * return null and let the caller treat it as an unreadable photo.
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
  // WebP: "RIFF" + 4-byte length + "WEBP"
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

/**
 * The curricula this analysis considers.
 *
 * Always narrow by stage. "Every curriculum in that language" would list all 52
 * Math I-C entries as candidates for a middle-schooler's photo and let the
 * analyser pick a high-school unit. The prompt also grows linearly with the
 * number of curricula.
 *
 * Narrow by subject too when it is known. One stage holds both a math and an
 * English curriculum, so without it an English photo can pick up math ids. If a
 * mixed-in id comes first, the agent's `subjectOf()` decides the whole lesson's
 * subject from it - an English photo would start a math board with spoken-math
 * corrections.
 *
 * The subject is known only *after* the photo is read, so the list pasted into
 * the prompt ({@link curriculumDigest}) can only be narrowed by stage. Only the
 * matching side can narrow further.
 */
function tracksFor(
  locale: CurriculumLocale,
  stage: SchoolStage,
  subject?: AnalysisSubject,
): TrackId[] {
  const eligible = tracksForStage(stage, locale);
  if (subject === undefined || subject === "other") return eligible;
  return eligible.filter((track) => curriculumTracks[track].subject === subject);
}

/** Folds that curriculum's map into a form that can be pasted into the prompt. */
export function curriculumDigest(
  locale: CurriculumLocale = "ja",
  stage: SchoolStage = "high_school",
): string {
  return topicsForTracks(tracksFor(locale, stage))
    .map((topic) => `- ${topic.id} | ${topic.course} / ${topic.unit} / ${topic.topic}`)
    .join("\n");
}

export function photoAnalysisPrompt(
  locale: CurriculumLocale = "ja",
  stage: SchoolStage = "high_school",
): string {
  return renderPrompt(getPrompt("photo_analysis", locale), {
    curriculum_digest: curriculumDigest(locale, stage),
  });
}

/**
 * Matches the topic_ids the LLM returned and builds the allow-list (guardrail
 * stage 1).
 *
 * Three stages of narrowing:
 *
 *   1. curriculum (stage x subject). Both an `A1-...` absent from a Japanese
 *      prompt and an `M2-...` attached to an English photo fall out here
 *   2. if nothing remains, keyword inference from the photo text
 *   3. if still empty, the curriculum's landing point (`fallback_topic_id`)
 *
 * Stage 3 exists for English curricula. Math notes literally contain
 * "discriminant" and "√", but an English notebook never says "to-infinitive" -
 * it contains English sentences, so keyword matching barely works. Returning
 * empty here would get a perfectly readable photo rejected by the caller as
 * `photo_unreadable`.
 */
export function resolveDetectedTopics(
  analysis: PhotoAnalysis,
  locale: CurriculumLocale = "ja",
  stage: SchoolStage = "high_school",
): {
  topicIds: string[];
  droppedIds: string[];
} {
  const droppedIds: string[] = [];
  const topicIds: string[] = [];
  const eligible = tracksFor(locale, stage, analysis.subject);
  const inCurriculum = new Set(topicsForTracks(eligible).map((t) => t.id));

  for (const entry of analysis.topics) {
    if (isKnownTopicId(entry.topic_id) && inCurriculum.has(entry.topic_id)) {
      topicIds.push(entry.topic_id);
    } else {
      droppedIds.push(entry.topic_id);
    }
  }

  if (topicIds.length === 0 && analysis.subject !== "other") {
    const haystack = [analysis.summary, ...analysis.visible_work, ...analysis.question_seeds].join(
      " ",
    );
    topicIds.push(...suggestTopics(haystack, 3, { tracks: eligible }).map((t) => t.id));
  }

  // Keywords missed too. This happens routinely in English, so drop to the
  // curriculum's landing point (curricula without one stay empty = rejected as before).
  if (topicIds.length === 0 && analysis.subject !== "other") {
    for (const track of eligible) {
      const fallback = curricula[track].fallback_topic_id;
      if (fallback !== undefined) {
        topicIds.push(fallback);
        break;
      }
    }
  }

  return { topicIds: [...new Set(topicIds)], droppedIds };
}

/**
 * Decides which problem this session handles, from the analysis result (the
 * problem-text counterpart of guardrail stage 1).
 *
 * It stands where `resolveDetectedTopics` stands for topic_ids: a layer for not
 * trusting the LLM's output. Five outcomes:
 *
 *   - `read` ... readable; the starting point of the conversation
 *   - `not_found` ... not in the photo (or the analyser returned empty).
 *     This is not a failure. The problem photo is optional (§4-1), so the
 *     session still stands, and the senpai opens with "could you read the
 *     problem out?"
 *   - `too_long` ... over the cap = the whole page was transcribed. Truncating
 *     would teach a problem cut mid-question, so it is discarded whole. It very
 *     likely includes the chapter's answers, which would have the senpai read
 *     the answer aloud
 *   - `solution_included` / `not_a_problem` ... rejected by
 *     {@link checkProblemText} in `@ai-sensei/guardrail`
 *
 * Every failure only sets `problem` to `null`; the session is never stopped.
 * There is no re-analysis: answers get mixed in because of *what part of the
 * page was photographed*, so the same photo returns the same thing. Paying for
 * Vision again plus seconds of session start usually just buys the same result.
 *
 * The failures are not collapsed into `not_found` because they are observable
 * signals: repeated `too_long` means the 600-char instruction in
 * `prompts/photo_analysis.*.md` is not landing; repeated `solution_included`
 * means "do not take the answers" is not landing. Indistinguishable in logs,
 * neither would ever be noticed.
 */
export const problemOutcomes = [
  "read",
  "not_found",
  "too_long",
  "solution_included",
  "not_a_problem",
] as const;
export type ProblemOutcome = (typeof problemOutcomes)[number];

export function resolveSessionProblem(input: {
  analysis: PhotoAnalysis | null;
  /** Whether a `problem_photo` part was sent. Used to record where it was read from. */
  hadProblemPhoto: boolean;
}): { problem: SessionProblem | null; outcome: ProblemOutcome } {
  const text = input.analysis?.problem_text.trim() ?? "";
  if (text.length === 0) return { problem: null, outcome: "not_found" };
  if (text.length > problemTextMaxLength) return { problem: null, outcome: "too_long" };

  /**
   * Content validity is the guardrail's job (the same split as `topicIdSchema`).
   *
   * Since a rejection means falling back to "teach without looking at a problem
   * that is right there", that side is written to pass when unsure. Do not
   * override that policy here - extra conditions on this side would split the
   * policy across two places and make its strictness unreadable.
   */
  const verdict = checkProblemText(text);
  if (!verdict.ok) return { problem: null, outcome: verdict.reason };

  return {
    problem: { text, source: input.hadProblemPhoto ? "problem_photo" : "notes_photo" },
    outcome: "read",
  };
}

export function toDetectedTopicPayload(
  topicIds: readonly string[],
  analysis: PhotoAnalysis,
): {
  topic_id: string;
  course: string;
  unit: string;
  topic: string;
  label: string;
  confidence: number;
}[] {
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
        // The short curriculum label for the chip. Built by one curriculum-side function (ADR 0007)
        label: topicLabel(topic),
        // Anything that fell back to keyword inference gets an explicitly low confidence
        confidence: confidenceById.get(topicId) ?? 0.4,
      },
    ];
  });
}

/** Ask in the same language as the system prompt. Asking in Japanese returns a Japanese summary even for an English prompt. */
const analysisInstruction: Record<CurriculumLocale, string> = {
  ja: "このノートを解析してJSONだけを返してください。",
  en: "Analyze these notes and return the JSON only.",
};

/**
 * The heading placed before each image.
 *
 * When both images go in one call, say in words which is which. Two unlabelled
 * images make the analyser put the workbook page into `visible_work` as "the
 * student's work" (= misreading a printed model answer as something they did).
 *
 * With notes only, add no label. Told "image 1", the analyser starts answering
 * on the assumption of an image 2 that is not there.
 *
 * With the problem only, always add a label. The system prompt
 * (`prompts/photo_analysis.*.md`) says "if there is no second image, look for
 * the problem in the notes photo", i.e. it assumes a lone image is the notes.
 * The problem-only path was added afterwards, so without cancelling that here,
 * a printed page becomes "the student's work" wholesale.
 */
const imageLabels: Record<
  CurriculumLocale,
  { notes: string; problem: string; problemOnly: string }
> = {
  ja: {
    notes: "1枚目 — 生徒のノート:",
    problem: "2枚目 — 問題(教科書・問題集の紙面):",
    problemOnly:
      "問題(教科書・問題集の紙面)。ノートの写真はありません — visible_work は空にしてください:",
  },
  en: {
    notes: "Photo 1 — the student's notes:",
    problem: "Photo 2 — the problem (a textbook or workbook page):",
    problemOnly:
      "The problem (a textbook or workbook page). There is no photo of the notes — leave visible_work empty:",
  },
};

export type AnthropicAnalyzerOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** The Vision analyser that calls the Anthropic Messages API. */
export function createAnthropicAnalyzer(options: AnthropicAnalyzerOptions): PhotoAnalyzer {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";

  return {
    async analyze({ notes, problem, locale = "ja", stage = "high_school" }) {
      // With two images, pass them in one call. Two separate calls would
      // (a) double the Vision bill (§6-1 estimates "problem + notes" as one item)
      // (b) stop the analyser from cross-referencing them - a notes-only pass has
      //     to guess the unit without knowing which problem is being solved.
      //     Cross-referencing is exactly the point of sending both (§0 decision 4).
      const labels = imageLabels[locale];
      const content: Record<string, unknown>[] = [];

      const pushImage = (label: string | null, picture: PhotoAnalysisImage) => {
        if (label !== null) content.push({ type: "text", text: label });
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: picture.contentType,
            data: toBase64(picture.image),
          },
        });
      };

      if (notes) pushImage(problem ? labels.notes : null, notes);
      if (problem) pushImage(notes ? labels.problem : labels.problemOnly, problem);
      content.push({ type: "text", text: analysisInstruction[locale] });

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
          system: photoAnalysisPrompt(locale, stage),
          messages: [{ role: "user", content }],
        }),
      });

      if (!response.ok) {
        // Dropping the body leaves only "it was a 500", with no way to tell an
        // expired key from overload from an oversized image. Truncate the length
        // only, and put the reason on the error.
        const detail = await response.text().catch(() => "");
        throw new Error(`vision APIが失敗しました: ${response.status} ${detail.slice(0, 300)}`);
      }

      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
      const text = payload.content?.find((part) => part.type === "text")?.text ?? "";
      return photoAnalysisSchema.parse(extractJson(text));
    },
  };
}

/** Still parseable when it comes back with a ```json fence or a preamble. */
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
