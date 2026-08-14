import type { ApiErrorCode } from "@ai-sensei/contract";
import { HTTPException } from "hono/http-exception";

/**
 * Error text goes straight to the user. Write it without nagging or blaming:
 * not "limit reached" but "tell me the rest tomorrow".
 */
const messages: Record<ApiErrorCode, { ja: string; en: string; status: number }> = {
  unauthorized: {
    ja: "うまく接続できませんでした。アプリを開き直してみてください。",
    en: "We couldn't verify this device. Please reopen the app.",
    status: 401,
  },
  free_limit_reached: {
    ja: "今日のセッションはここまでです。また明日、続きを聞かせてください。",
    en: "That's all for today. Come back tomorrow and tell me the rest.",
    status: 402,
  },
  fair_use_limit_reached: {
    // Never show the Premium cap's number; per §6-3, the senpai closes the study session.
    ja: "今日はここまでにしよっか。詰め込みすぎても入らないから、また明日続きをやろう。",
    en: "Let's stop here for today. Cramming more won't help it stick, so let's continue tomorrow.",
    status: 429,
  },
  premium_required: {
    // Plan mode and re-asking a lesson by voice both return the same
    // `premium_required`. Naming the paid feature would misdirect on other flows,
    // so it stays generic while naming the quiz and karte that remain free, so it
    // does not look like everything is closed.
    ja: "この機能はPremiumで利用できます。無料のままでも、小テストと今日のカルテは使えます。",
    en: "This feature is available with Premium. Quick quizzes and today's karte stay free.",
    status: 402,
  },
  photo_unreadable: {
    ja: "写真からノートを読み取れませんでした。もう一度撮ってみてください。",
    en: "We couldn't read any notes in this photo. Could you take another one?",
    status: 422,
  },
  // Never enumerate subject names. Text that needs editing per added curriculum
  // always goes stale somewhere, answering "unsupported" for something supported.
  out_of_scope: {
    ja: "このノートは、いま対応している範囲の外みたいです。中学・高校の数学と英語に対応しています。",
    en: "This looks outside what we cover. We support maths and English for junior high and high school.",
    status: 422,
  },
  session_not_found: {
    ja: "このセッションは見つかりませんでした。",
    en: "Session not found.",
    status: 404,
  },
  hole_not_found: {
    ja: "この穴は見つかりませんでした。復習画面を開き直してみてください。",
    en: "We couldn't find this gap. Please reopen the review screen.",
    status: 404,
  },
  rate_limited: {
    ja: "少し時間をおいてから、もう一度お願いします。",
    en: "Please try again in a moment.",
    status: 429,
  },
  internal_error: {
    ja: "うまくいきませんでした。少し時間をおいて試してみてください。",
    en: "Something went wrong. Please try again shortly.",
    status: 500,
  },
};

export function apiError(
  code: ApiErrorCode,
  options: { locale?: string; retryAfterSeconds?: number } = {},
): HTTPException {
  const entry = messages[code];
  const message = options.locale === "en" ? entry.en : entry.ja;
  const body: Record<string, unknown> = { code, message };
  if (options.retryAfterSeconds !== undefined) {
    body["retry_after_seconds"] = options.retryAfterSeconds;
  }

  return new HTTPException(entry.status as 400, {
    res: new Response(JSON.stringify({ error: body }), {
      status: entry.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  });
}

export function errorStatus(code: ApiErrorCode): number {
  return messages[code].status;
}
