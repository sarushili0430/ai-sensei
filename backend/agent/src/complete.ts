import type { CompleteSessionRequest } from "@ai-sensei/contract";

/**
 * セッションの完了を backend/api へ送る口と、そこで使う汎用のLLMクライアント。
 *
 * **ここは `karte.ts` だったもの。**カルテは ADR 0009 で畳んだので、
 * ファイルごと畳んで「完了を送る」と「LLMを1往復叩く」だけを残した。
 * LiveKitに依存しないので、単体でテストできる。
 */

export type LlmClient = {
  complete(input: { system: string; user: string; maxTokens: number }): Promise<string>;
};

/**
 * `/complete` 1回ぶんの上限。
 *
 * 返事が来ない接続を掴んだままにすると、送り直しにも入れないまま
 * ジョブが終わる。アプリからは「復習問題がいつまでも来ない」に見える。
 */
export const postCompleteTimeoutMs = 15_000;

export type PostCompleteOptions = {
  apiBaseUrl: string;
  internalToken: string;
  sessionId: string;
  body: CompleteSessionRequest;
  fetchImpl?: typeof fetch;
  /** 送り直す回数。1回きりだと、一瞬の失敗で復習問題が永久に表に出ない。 */
  attempts?: number;
  /** 待ち時間(テストから0にする)。 */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 完了をAPIへ送る。
 *
 * **ここが通らないと、会話が成立していても復習問題は存在しないことになる。**
 * 通知は `/complete` の裏で予約されるので、送信の失敗は生徒から見ると
 * 「3日後に何も来ない」— しかもその日まで誰も気づけない。
 * `/complete` は冪等(既にあれば保存済みを返す)なので、落ちたら送り直す。
 *
 * 4xx は送り直しても同じなので、すぐ諦める(トークンずれ・契約違反)。
 */
export async function postComplete({
  apiBaseUrl,
  internalToken,
  sessionId,
  body,
  fetchImpl = fetch,
  attempts = 3,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: PostCompleteOptions): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${apiBaseUrl}/v1/sessions/${sessionId}/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${internalToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(postCompleteTimeoutMs),
      });

      if (response.ok) return;

      const detail = await response.text().catch(() => "");
      const error = new Error(`/complete が失敗しました: ${response.status} ${detail}`);
      if (response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      // 4xx はここで throw されたもの。送り直さない。
      if (error instanceof Error && /失敗しました: 4/.test(error.message)) throw error;
      lastError = error;
    }

    if (attempt < attempts) await sleep(attempt * 1000);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLMの出力にJSONが見つかりません");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * 会話の外で回すLLM呼び出しの上限。
 *
 * ここで詰まると、会話は終わっているのに `/complete` が永久に送られない。
 * **待つのをやめて問題なしで送る**ほうが、待たせ続けるよりずっとまし
 * (呼び出し側が catch して `practice_problem: null` に落とす)。
 */
export const llmTimeoutMs = 60_000;

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function createAnthropicClient(options: AnthropicOptions): LlmClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";

  return {
    async complete({ system, user, maxTokens }) {
      const response = await doFetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(llmTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`LLMの呼び出しに失敗しました: ${response.status}`);
      }
      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
      return payload.content?.find((part) => part.type === "text")?.text ?? "";
    },
  };
}
