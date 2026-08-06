import { describe, expect, it } from "vitest";
import {
  RequestLogger,
  describeError,
  deviceTag,
  errorCodeOf,
  readLogLevel,
  setErrorReporter,
} from "./observability.ts";

function capture() {
  const lines: string[] = [];
  return {
    lines,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    sink: (line: string) => lines.push(line),
  };
}

describe("RequestLogger", () => {
  it("1行1JSONで、全行に同じtrace_idが入る", () => {
    const sink = capture();
    const log = new RequestLogger("trace-1", { environment: "develop" }, "info", sink.sink);

    log.info("http_request", { status: 200 });
    log.warn("guardrail_rejected", { topic_id: "M2-ZUKEI-ENCHOKU" });

    expect(sink.parsed()).toEqual([
      {
        level: "info",
        event: "http_request",
        trace_id: "trace-1",
        environment: "develop",
        status: 200,
      },
      {
        level: "warn",
        event: "guardrail_rejected",
        trace_id: "trace-1",
        environment: "develop",
        topic_id: "M2-ZUKEI-ENCHOKU",
      },
    ]);
  });

  // 原因はログにしか残らない。スタックを落とすと調べようがなくなる。
  it("エラーは名前・メッセージ・スタックまで残す", () => {
    const sink = capture();
    const log = new RequestLogger("trace-2", {}, "info", sink.sink);

    log.error("unhandled_error", new Error("D1 timeout"), { route: "/v1/sessions" });

    const [line] = sink.parsed();
    expect(line?.["error_name"]).toBe("Error");
    expect(line?.["error_message"]).toBe("D1 timeout");
    expect(line?.["error_stack"]).toContain("D1 timeout");
    expect(line?.["route"]).toBe("/v1/sessions");
  });

  it("level=errorでは、全リクエストの1行を出さない", () => {
    const sink = capture();
    const log = new RequestLogger("trace-3", {}, "error", sink.sink);

    log.info("http_request", { status: 200 });
    log.warn("something", {});
    log.error("unhandled_error", new Error("boom"));

    expect(sink.parsed().map((line) => line["event"])).toEqual(["unhandled_error"]);
  });

  it("外部の受け皿にも同じものを渡す(Sentry)", () => {
    const sink = capture();
    const reported: { error: unknown; context: Record<string, unknown> }[] = [];
    setErrorReporter((error, context) => reported.push({ error, context }));

    const log = new RequestLogger("trace-4", { environment: "production" }, "info", sink.sink);
    const failure = new Error("boom");
    log.error("unhandled_error", failure, { route: "/v1/me/progress" });

    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toBe(failure);
    expect(reported[0]?.context).toMatchObject({
      event: "unhandled_error",
      trace_id: "trace-4",
      environment: "production",
      route: "/v1/me/progress",
    });

    setErrorReporter(null);
  });

  it("受け皿が無くても落ちない(ローカル開発)", () => {
    const sink = capture();
    const log = new RequestLogger("trace-5", {}, "info", sink.sink);
    expect(() => log.error("unhandled_error", new Error("boom"))).not.toThrow();
  });
});

describe("describeError", () => {
  it("Errorでないものを投げられても構造化する", () => {
    expect(describeError("文字列を投げられた")).toEqual({
      error_name: "NonError",
      error_message: "文字列を投げられた",
    });
  });

  it("causeも残す", () => {
    const error = new Error("外側", { cause: new Error("内側") });
    expect(describeError(error)["error_cause"]).toContain("内側");
  });
});

describe("deviceTag", () => {
  // 匿名IDでも端末をまたいで追える識別子なので、相関に足るぶんだけにする
  it("先頭8文字だけにする", () => {
    expect(deviceTag("0123456789abcdef")).toBe("01234567");
    expect(deviceTag(undefined)).toBeUndefined();
  });
});

describe("errorCodeOf", () => {
  it("アプリに返したエラーコードを拾う", async () => {
    const response = new Response(JSON.stringify({ error: { code: "free_limit_reached" } }), {
      status: 402,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(await errorCodeOf(response)).toBe("free_limit_reached");
  });

  it("成功レスポンスは読まない(本文を無駄に消費しない)", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(await errorCodeOf(response)).toBeUndefined();
    expect(response.bodyUsed).toBe(false);
  });

  it("JSONでない失敗でも落ちない", async () => {
    const response = new Response("boom", { status: 500 });
    expect(await errorCodeOf(response)).toBeUndefined();
  });
});

describe("readLogLevel", () => {
  it("既定はinfo(何も起きていないことも見えるように)", () => {
    expect(readLogLevel(undefined)).toBe("info");
    expect(readLogLevel({})).toBe("info");
    expect(readLogLevel({ LOG_LEVEL: "debug" })).toBe("info");
  });

  it("errorだけ絞れる", () => {
    expect(readLogLevel({ LOG_LEVEL: "error" })).toBe("error");
  });
});
