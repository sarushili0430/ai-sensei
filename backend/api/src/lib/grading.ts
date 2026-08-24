import { type PracticeVerdict, practiceVerdictSchema } from "@ai-sensei/contract";
import type { CurriculumLocale } from "@ai-sensei/curriculum";
import { practiceGradingSystemPrompt } from "@ai-sensei/prompts";
import { z } from "zod";

/**
 * 復習問題の採点(ADR 0009)。
 *
 * **ここが「AIが採点する」の実体。**旧カルテの小テストは採点せず、本人が
 * 「言えた / まだ」を申告するだけだった。反転した理由と代償は ADR 0009 にある。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【落ち方は必ず `unclear` へ】
 * ─────────────────────────────────────────────────────────────────────────
 *
 * LLMが落ちた・読めない出力を返した・タイムアウトした — どれも
 * **生徒の答案とは無関係の失敗**なので、`incorrect` にしない。
 * `incorrect` は「1日後・3日後・7日後にもう一度たずねる」に直結していて、
 * こちらの事故をその扱いで生徒の記録に残すことになる。
 */

export type PracticeGrading = {
  verdict: PracticeVerdict;
  /** 結果画面に出す先輩の一言。読めなかったときは `null`。 */
  comment: string | null;
  /** 採点したモデル名。採点の質が落ちた期間を後から切り分けるために残す。 */
  gradedBy: string;
};

export type PracticeGrader = {
  grade(input: {
    question: string;
    answer: string;
    response: string;
    locale?: CurriculumLocale;
  }): Promise<PracticeGrading>;
};

const gradingOutputSchema = z.object({
  verdict: practiceVerdictSchema,
  comment: z.string().min(1).max(200).nullable().default(null),
});

/**
 * 採点が成立しなかったときの結果。
 *
 * `graded_by` に**理由の分かる名前**を入れる。`unclear` が増えたときに、
 * 「モデルが読めなかった」のか「呼び出しごと落ちた」のかを後から分けられないと、
 * 直す場所が決まらない。
 */
export function ungraded(reason: "unavailable" | "unreadable"): PracticeGrading {
  return { verdict: "unclear", comment: null, gradedBy: `ungraded:${reason}` };
}

/**
 * 採点1回ぶんの上限。
 *
 * **画面が待っている。**⑦「採点待ち」は問題と自分の答えを出したまま止まるので、
 * ここが長いほどその画面が伸びる。「閉じても、あとで結果を見られるよ」と
 * 書いてあるとはいえ、20秒を超えると閉じられる。
 */
export const gradingTimeoutMs = 20_000;

export type AnthropicGraderOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function createAnthropicGrader(options: AnthropicGraderOptions): PracticeGrader {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";

  return {
    async grade({ question, answer, response, locale = "ja" }) {
      let raw: string;
      try {
        const result = await doFetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: 400,
            system: practiceGradingSystemPrompt({ question, answer, response }, { locale }),
            messages: [{ role: "user", content: gradingInstruction[locale] }],
          }),
          signal: AbortSignal.timeout(gradingTimeoutMs),
        });
        if (!result.ok) return ungraded("unavailable");
        const payload = (await result.json()) as { content?: { type: string; text?: string }[] };
        raw = payload.content?.find((part) => part.type === "text")?.text ?? "";
      } catch {
        return ungraded("unavailable");
      }

      const parsed = gradingOutputSchema.safeParse(extractJson(raw));
      if (!parsed.success) return ungraded("unreadable");
      return {
        verdict: parsed.data.verdict,
        comment: parsed.data.comment,
        gradedBy: options.model,
      };
    },
  };
}

/** 採点の指示。systemと同じ言語で頼む(混ぜると出力の言語が揺れる)。 */
const gradingInstruction: Record<CurriculumLocale, string> = {
  ja: "この解答の採点JSONだけを返してください。",
  en: "Return only the grading JSON for this answer.",
};

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
