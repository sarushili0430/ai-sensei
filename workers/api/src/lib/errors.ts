import type { ApiErrorCode } from "@ai-sensei/contract";
import { HTTPException } from "hono/http-exception";

/**
 * エラー文言はユーザーにそのまま出る。**煽らない・責めない**文体で書く。
 * 「制限に達しました」ではなく「また明日、続きを聞かせてください」。
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
  premium_required: {
    ja: "穴の復習はPremiumの機能です。無料のままでも、今日のカルテは見られます。",
    en: "Reviewing past gaps is a Premium feature. Today's karte stays free.",
    status: 402,
  },
  photo_unreadable: {
    ja: "写真から数学のノートを読み取れませんでした。もう一度撮ってみてください。",
    en: "We couldn't read a math note in this photo. Could you take another one?",
    status: 422,
  },
  out_of_scope: {
    ja: "このノートは高校数学の範囲外みたいです。今は数学だけに対応しています。",
    en: "This looks outside high-school math. We only cover math for now.",
    status: 422,
  },
  session_not_found: {
    ja: "このセッションは見つかりませんでした。",
    en: "Session not found.",
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
