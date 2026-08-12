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

/**
 * 写真に写っている教科。
 *
 * `is_math_note: boolean` から替えた。対応教科が数学だけだった頃は真偽値で
 * 足りたが、英語を足すと「数学ではない」と「対応していない」が別物になる。
 * **`other` だけが範囲外**で、それ以外は課程を絞る手がかりになる。
 */
export const analysisSubjects = ["math", "english", "other"] as const;
export type AnalysisSubject = (typeof analysisSubjects)[number];

export const photoAnalysisSchema = z.object({
  /** 既定を `other` にしない — 解析器が欄を落としたときに、写真を捨てる方へ倒れる。 */
  subject: z.enum(analysisSubjects).default("math"),
  summary: z.string(),
  /**
   * 解いている問題そのものの書き起こし(計画書 §0 の決定4「問題とノートをセットで送る」)。
   *
   * **読めなければ空文字**。既定を `""` にしてあるのは、解析器が古い形で返しても
   * セッションが始まるようにするため — ここで parse に失敗させると、
   * 問題文が読めないだけで**授業そのものが始まらなくなる**。
   * 空だったときに何をプロンプトへ渡すかは、呼び出し側(`routes/sessions.ts`)の責務。
   *
   * 上限は `@ai-sensei/contract` の `problemTextMaxLength`。**ここでは切らずに通す。**
   * 超えた場合は「紙面を丸ごと書き起こした」ということなので、
   * 黙って先頭600字を使うと、設問の途中で切れた問題を教えることになる。
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

/** 解析に渡す画像1枚。 */
export type PhotoAnalysisImage = { image: ArrayBuffer; contentType: string };

/**
 * 解析に渡すもの。**どちらか1枚は必ずある**ことを型で言っている。
 *
 * 配列(`images: [...]`)にしていないのは、2枚が対等ではないから:
 * ノートはR2に保存し、問題の紙面は**保存しない**(`contract` の `sessionPhotoParts`)。
 * 配列にすると、この非対称性が型から消える。
 *
 * 「両方 undefined」を書けなくしてあるのは、そこが**無音で壊れる形**だから —
 * 画像なしでVision APIを呼ぶと、解析器は写真を見ないまま `is_math_note: true` と
 * 想像で答えることがあり、**写真に無い単元でセッションが始まる**。
 */
export type PhotoAnalyzerInput = { locale?: CurriculumLocale; stage?: SchoolStage } & (
  | { notes: PhotoAnalysisImage; problem?: PhotoAnalysisImage }
  | { notes?: PhotoAnalysisImage; problem: PhotoAnalysisImage }
);

export type PhotoAnalyzer = {
  analyze(input: PhotoAnalyzerInput): Promise<PhotoAnalysis>;
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

/**
 * この解析で見る課程。
 *
 * **段階で必ず絞る。** 「その言語の課程を全部」にすると、中学生の写真にも
 * 数学I〜Cの52件が候補として並び、解析器が高校の単元を選べてしまう。
 * プロンプトに貼る量も課程の数だけ線形に増える。
 *
 * **教科が分かっているなら、そこでも絞る。** 1つの段には数学と英語の2課程が
 * あるので、教科で絞らないと英語の写真に数学のIDが混ざりうる。混ざったIDが
 * 先頭に来ると、agent 側の `subjectOf()` が**それで授業全体の教科を決める** —
 * 英語の写真で数学の板書と数式の音声補正が始まる。
 *
 * 教科が分かるのは写真を読んだ**あと**なので、プロンプトに貼る一覧
 * ({@link curriculumDigest})は段でしか絞れない。絞れるのは照合の側だけ。
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

/** その課程のカリキュラムマップを、プロンプトに貼れる形に畳む。 */
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
 * LLMが返したtopic_idを照合し、許可リストを作る(ガードレール1段目)。
 *
 * 絞りは3段:
 *
 *   1. **課程**(段階 × 教科)。日本語のプロンプトに載っていない `A1-...` も、
 *      英語の写真に付いた `M2-...` も、ここで落ちる
 *   2. 1件も残らなければ、写真テキストからの**キーワード推定**
 *   3. それでも空なら、その課程の**着地点**(`fallback_topic_id`)
 *
 * 3段目が要るのは英語の課程。数学は「判別式」「√」がそのままノートに写るが、
 * **英語のノートに「to不定詞」とは書かれていない** — 写っているのは英文で、
 * キーワード照合が効きにくい。ここで空のまま返すと、読めている写真が
 * 呼び出し側で `photo_unreadable` として弾かれる。
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

  // キーワードでも当たらなかった。**英語ではこれが普通に起きる**ので、
  // 課程が用意している着地点へ降ろす(無い課程は空のまま = 従来どおり弾かれる)。
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
 * 解析結果から、そのセッションが扱う問題を決める(ガードレール1段目の問題文版)。
 *
 * `resolveDetectedTopics` が topic_id にやっていることと同じ立ち位置で、
 * **LLMの出力をそのまま信じないための一段**。3つに分かれる:
 *
 *   - `read` … 読めた。会話の起点になる
 *   - `not_found` … 写っていない(または解析器が空で返した)。
 *     **これは失敗ではない。** 問題の写真は必須ではないので(§4-1)、
 *     セッションはこのまま成立する。先輩は「問題、読んでもらってもいい?」から始める
 *   - `too_long` … 上限を超えた = **紙面を丸ごと書き起こしている**。
 *     先頭で切ると設問の途中で切れた問題を教えることになるので、**丸ごと捨てる**。
 *     章末の解答まで書き起こしている可能性が高く、そのまま渡すと先輩が答えを読み上げる
 *   - `solution_included` / `not_a_problem` … `@ai-sensei/guardrail` の
 *     {@link checkProblemText} が弾いたもの
 *
 * **どの落ち方でも `problem` は `null` にするだけで、セッションは止めない。**
 * 再解析はしない: 解答が混ざる原因は「紙面のどこを写したか」なので、
 * **同じ写真をもう一度投げても同じものが返る**。Vision の課金とセッション開始の
 * 数秒を払って、同じ結果を得るだけになりやすい。
 *
 * 落ち方を `not_found` にまとめないのは、**観測のため**。
 * `too_long` が続けば `prompts/photo_analysis.*.md` の600字の指示が効いていない、
 * `solution_included` が続けば「解答は取らない」の指示が効いていない、と読み分けられる。
 * ログで区別できないと、どちらも永遠に気づけない。
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
  /** `problem_photo` パートが送られてきたか。読み取り元の記録に使う。 */
  hadProblemPhoto: boolean;
}): { problem: SessionProblem | null; outcome: ProblemOutcome } {
  const text = input.analysis?.problem_text.trim() ?? "";
  if (text.length === 0) return { problem: null, outcome: "not_found" };
  if (text.length > problemTextMaxLength) return { problem: null, outcome: "too_long" };

  /**
   * 中身の妥当性は guardrail の担当(`topicIdSchema` と同じ分担)。
   *
   * **弾いた結果は「問題が写っているのに見ないまま教える」に戻る**ので、
   * 向こうは「迷ったら通す」で書いてある。ここでその方針を上書きしない —
   * 追加の条件をこちら側に足すと、方針が2か所に分かれて緩急が読めなくなる。
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
        // チップに出す短い課程名。作るのはカリキュラム側の1関数だけ(ADR 0007)
        label: topicLabel(topic),
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

/**
 * 各画像の前に置く見出し。
 *
 * **2枚を1回の呼び出しで渡すときは、どちらがどちらかを言葉で教える。**
 * ラベルなしで2枚並べると、解析器は問題集の紙面を「生徒が書いた作業」として
 * `visible_work` に入れる(= 印刷された模範解答を、生徒がやったことだと誤読する)。
 *
 * **ノートだけのときはラベルを付けない。**「1枚目」と言われると、
 * 解析器は写っていない2枚目を前提に答えはじめる。
 *
 * **問題だけのときは、必ずラベルを付ける。**
 * システムプロンプト(`prompts/photo_analysis.*.md`)は「2枚目が無ければ、
 * ノートの写真に問題が写っていないか探す」と書いてあり、**1枚しか無い場合は
 * それをノートだと想定している**。問題だけを送る経路はそのあとに増えたので、
 * ここで打ち消さないと、印刷された紙面がまるごと「生徒がやった作業」になる。
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

/** Anthropic Messages API を叩くVision解析器。 */
export function createAnthropicAnalyzer(options: AnthropicAnalyzerOptions): PhotoAnalyzer {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";

  return {
    async analyze({ notes, problem, locale = "ja", stage = "high_school" }) {
      // 2枚あるときは **1回の呼び出し** で渡す。分けて2回叩くと、
      // (a) Vision の課金が2倍になる(§6-1 の見積もりは「問題+ノート2枚」で1項目)
      // (b) **解析器が2枚を突き合わせられない** — ノートだけを見た回は
      //     「何の問題を解いているか」を知らないまま単元を当てることになる。
      //     問題とノートをセットで送る(§0 決定4)の意味は、まさにこの突き合わせにある。
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
