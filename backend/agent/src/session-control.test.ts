import {
  sessionControlProtocolVersion,
  sessionControlResponseSchema,
  sessionControlRpcMethod,
} from "@ai-sensei/contract";
import { describe, expect, it, vi } from "vitest";
import { readSessionContext } from "./context.ts";
import {
  type RpcRegistrar,
  SessionControlInbox,
  registerSessionControl,
} from "./session-control.ts";
import { sessionMetadataJson } from "./test-support.ts";

function recordingRegistrar() {
  let method = "";
  let handler: ((data: { callerIdentity: string; payload: string }) => Promise<string>) | undefined;
  const registrar: RpcRegistrar = {
    registerRpcMethod(nextMethod, nextHandler) {
      method = nextMethod;
      handler = nextHandler;
    },
    unregisterRpcMethod: vi.fn(),
  };
  return {
    registrar,
    get method() {
      return method;
    },
    invoke(data: { callerIdentity: string; payload: string }) {
      if (!handler) throw new Error("RPCが登録されていません");
      return handler(data);
    },
  };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("session control RPC", () => {
  it("更新通知では内部APIを読み直した文脈だけをinboxへ渡す", async () => {
    const rpc = recordingRegistrar();
    const inbox = new SessionControlInbox();
    const next = readSessionContext(
      sessionMetadataJson({
        context_revision: 2,
        problem_text: "二次関数 y = x^2 - 6x + 5 の頂点を求めよ。",
        allowed_topic_ids: ["M1-NIJI-GURAFU"],
      }),
    );
    const fetchContext = vi.fn(async () => next);
    const stop = new AbortController();

    registerSessionControl({
      registrar: rpc.registrar,
      studentIdentity: "student_1",
      sessionId: next.session_id,
      getCurrentContext: () => readSessionContext(sessionMetadataJson()),
      fetchContext,
      inbox,
      log,
    });
    expect(rpc.method).toBe(sessionControlRpcMethod);

    const response = await rpc.invoke({
      callerIdentity: "student_1",
      payload: JSON.stringify({
        v: sessionControlProtocolVersion,
        type: "context_updated",
        session_id: next.session_id,
        context_revision: 2,
      }),
    });
    expect(sessionControlResponseSchema.safeParse(JSON.parse(response)).success).toBe(true);
    expect(fetchContext).toHaveBeenCalledOnce();
    const event = await inbox.take(stop.signal);
    expect(event).toMatchObject({
      type: "context_updated",
      context_revision: 2,
      context: { problem_text: expect.stringContaining("頂点") },
    });
  });

  it("解析中の合図は再取得せず、本人以外と別sessionは拒否する", async () => {
    const rpc = recordingRegistrar();
    const inbox = new SessionControlInbox();
    const context = readSessionContext(sessionMetadataJson());
    const fetchContext = vi.fn(async () => context);
    registerSessionControl({
      registrar: rpc.registrar,
      studentIdentity: "student_1",
      sessionId: context.session_id,
      getCurrentContext: () => context,
      fetchContext,
      inbox,
      log,
    });

    const analyzing = JSON.stringify({
      v: 1,
      type: "problem_photo_analyzing",
      session_id: context.session_id,
    });
    await expect(rpc.invoke({ callerIdentity: "other", payload: analyzing })).rejects.toThrow();
    await expect(
      rpc.invoke({
        callerIdentity: "student_1",
        payload: JSON.stringify({
          v: 1,
          type: "problem_photo_analyzing",
          session_id: "ses_other",
        }),
      }),
    ).rejects.toThrow();

    await rpc.invoke({ callerIdentity: "student_1", payload: analyzing });
    expect(fetchContext).not.toHaveBeenCalled();
    expect(await inbox.take(new AbortController().signal)).toMatchObject({
      type: "problem_photo_analyzing",
    });
  });
});
