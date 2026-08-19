import {
  type SessionControlRequest,
  sessionControlProtocolVersion,
  sessionControlRequestSchema,
  sessionControlResponseSchema,
  sessionControlRpcMethod,
} from "@ai-sensei/contract";
import type { SessionContext } from "./context.ts";
import type { JobLogger } from "./log.ts";

/** LiveKit Node SDKへ直接依存させないための、RPC登録に要る最小の形。 */
export type RpcRegistrar = {
  registerRpcMethod(
    method: string,
    handler: (data: { callerIdentity: string; payload: string }) => Promise<string>,
  ): void;
  unregisterRpcMethod(method: string): void;
};

export type SessionControlEvent =
  | Extract<SessionControlRequest, { type: "problem_photo_analyzing" | "problem_photo_failed" }>
  | (Extract<SessionControlRequest, { type: "context_updated" }> & {
      /** アプリ由来ではなく、内部APIから読み直した正本。 */
      context: SessionContext;
    });

/** 追加写真を読んでいる数秒を無音にしない。制御文なのでtranscriptには入れない。 */
export function problemPhotoBridge(locale: SessionContext["locale"]): string {
  return locale === "en" ? "I'm taking a look — give me a moment." : "見てるね、ちょっと待って。";
}

/** 失敗しても現在の会話へ戻れることを、その場で明示する。 */
export function problemPhotoFailedBridge(locale: SessionContext["locale"]): string {
  return locale === "en"
    ? "I couldn't read that one. We can keep going with the current problem."
    : "うまく読み取れなかったみたい。今の問題をそのまま続けよう。";
}

/**
 * 制御通知の待ち合わせ。本人の発話用 `StudentUtterances` と型から分けて、
 * うっかりtranscriptへ流せない形にする。
 */
export class SessionControlInbox {
  private readonly queue: SessionControlEvent[] = [];
  private waiter: ((event: SessionControlEvent | null) => void) | null = null;
  private readonly listeners = new Set<() => void>();

  push(event: SessionControlEvent): void {
    const waiter = this.waiter;
    if (waiter) {
      waiter(event);
    } else {
      this.queue.push(event);
    }
    for (const listener of [...this.listeners]) listener();
  }

  take(signal: AbortSignal): Promise<SessionControlEvent | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (signal.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (event: SessionControlEvent | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.waiter === settle) this.waiter = null;
        resolve(event);
      };
      const onAbort = () => settle(null);
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiter = settle;
    });
  }

  /** 通知が来た瞬間に、いま生成している古い問題の板書を中止するための合図。 */
  onPush(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * app → agent の制御RPCを1本だけ登録する。
 *
 * `context_updated` のpayloadにはrevisionしかない。ハンドラ内で内部APIを読み直してから
 * inboxへ積むため、後段はアプリが申告した問題文や許可集合に触れる余地がない。
 */
export function registerSessionControl(options: {
  registrar: RpcRegistrar;
  studentIdentity: string;
  sessionId: string;
  getCurrentContext: () => SessionContext;
  fetchContext: () => Promise<SessionContext>;
  inbox: SessionControlInbox;
  log: Pick<JobLogger, "info" | "warn" | "error">;
}): () => void {
  const { registrar, studentIdentity, sessionId, getCurrentContext, fetchContext, inbox, log } =
    options;

  registrar.registerRpcMethod(sessionControlRpcMethod, async (invocation) => {
    if (invocation.callerIdentity !== studentIdentity) {
      log.warn("session_control_wrong_caller", { caller: invocation.callerIdentity });
      throw new Error("この参加者からの制御通知は受け付けません");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(invocation.payload);
    } catch {
      throw new Error("制御通知がJSONではありません");
    }
    const parsed = sessionControlRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.session_id !== sessionId) {
      throw new Error("制御通知の形式かセッションIDが一致しません");
    }

    const request = parsed.data;
    if (request.type === "context_updated") {
      const context = await fetchContext();
      const fetchedRevision = context.context_revision ?? 1;
      if (fetchedRevision < request.context_revision) {
        throw new Error("APIの最新文脈が通知されたrevisionに追いついていません");
      }
      if (fetchedRevision <= (getCurrentContext().context_revision ?? 1)) {
        // モバイルは応答を受け取れないと同じRPCを再送する。ここでinboxへ積むと、
        // 正常に始まった2問目まで中止してしまうので、正本が既読ならackだけ返す。
        log.info("session_context_replayed", { context_revision: fetchedRevision });
        return JSON.stringify(
          sessionControlResponseSchema.parse({
            v: sessionControlProtocolVersion,
            accepted: true,
          }),
        );
      }
      inbox.push({ ...request, context });
      log.info("session_context_refreshed", { context_revision: fetchedRevision });
    } else {
      inbox.push(request);
    }

    return JSON.stringify(
      sessionControlResponseSchema.parse({
        v: sessionControlProtocolVersion,
        accepted: true,
      }),
    );
  });

  return () => registrar.unregisterRpcMethod(sessionControlRpcMethod);
}
