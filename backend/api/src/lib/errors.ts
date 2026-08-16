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
  fair_use_limit_reached: {
    // Premiumの上限値は見せず、§6-3どおり先輩が学習を締める言い方にする。
    ja: "今日はここまでにしよっか。詰め込みすぎても入らないから、また明日続きをやろう。",
    en: "Let's stop here for today. Cramming more won't help it stick, so let's continue tomorrow.",
    status: 429,
  },
  premium_required: {
    // 計画モードと声で聞き直す授業は、同じ `premium_required` を返す。
    // 有料側の機能名を固定すると別の導線で誤案内になるため汎用にしつつ、
    // 無料で残る小テストとカルテは明示して、すべて閉じたようには見せない。
    ja: "この機能はPremiumで利用できます。無料のままでも、小テストと今日のカルテは使えます。",
    en: "This feature is available with Premium. Quick quizzes and today's karte stay free.",
    status: 402,
  },
  photo_unreadable: {
    ja: "写真からノートを読み取れませんでした。もう一度撮ってみてください。",
    en: "We couldn't read any notes in this photo. Could you take another one?",
    status: 422,
  },
  /**
   * 手で打った問題文が、問題文として通らなかった。
   *
   * **落ち方(`solution_included` / `not_a_problem`)で文言を分けない。**
   * 分けるほうが親切に見えるが、打った本人にできることは
   * 「設問まで入れる」「答えを外す」の2つしかなく、どちらの落ち方でも
   * その2つを見せれば直せる。落ちた理由そのものはログに出す(観測はそちら)。
   *
   * **撮り直しを促さない。** ここに来た人の手元には直せるテキストがあり、
   * 写真の話へ戻すと、打つという逃げ道を自分で塞ぐことになる。
   */
  problem_text_rejected: {
    ja: "問題文として読み取れませんでした。「〜を求めよ」のような設問まで入れて、答えは入れずに書いてみてください。",
    en: 'That didn\'t read as a question. Include the instruction ("find…", "solve…") and leave the answer out.',
    status: 422,
  },
  // **教科名を数え上げない。** 課程を足すたびに文言を直す作りにすると、
  // どこかで必ず古いままになり、対応しているのに「対応していません」と返る。
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
