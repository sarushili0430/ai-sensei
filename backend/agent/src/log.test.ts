import { describe, expect, it } from "vitest";
import { JobLogger, describeError, setErrorReporter } from "./log.ts";

function capture() {
  const lines: string[] = [];
  const push = (line: string) => lines.push(line);
  return {
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    sink: push,
  };
}

describe("JobLogger", () => {
  it("1行1JSONで、どのジョブの話か分かる形にする", () => {
    const out = capture();
    const log = new JobLogger({ room: "ses_1", job_id: "AJ_1" }, out.sink, out.sink);

    log.info("job_started");

    expect(out.parsed()).toEqual([
      { level: "info", event: "job_started", component: "agent", room: "ses_1", job_id: "AJ_1" },
    ]);
  });

  // 文脈を読んだあとは、APIのログと session_id で突き合わせられるようにする
  it("childでsession_idを全行に足せる", () => {
    const out = capture();
    const log = new JobLogger({ room: "ses_1" }, out.sink, out.sink).child({ session_id: "ses_1" });

    log.info("conversation_started", { turns: 0 });

    expect(out.parsed()[0]).toMatchObject({ session_id: "ses_1", room: "ses_1", turns: 0 });
  });

  it("エラーはスタックまで残し、受け皿にも渡す", () => {
    const out = capture();
    const reported: { error: unknown; context: Record<string, unknown> }[] = [];
    setErrorReporter((error, context) => reported.push({ error, context }));

    const log = new JobLogger({ session_id: "ses_1" }, out.sink, out.sink);
    const failure = new Error("api unreachable");
    log.error("complete_failed", failure, { ended_reason: "timeout" });

    const [line] = out.parsed();
    expect(line?.["level"]).toBe("error");
    expect(line?.["error_message"]).toBe("api unreachable");
    expect(line?.["error_stack"]).toContain("api unreachable");
    expect(reported[0]?.error).toBe(failure);
    expect(reported[0]?.context).toMatchObject({
      event: "complete_failed",
      session_id: "ses_1",
      ended_reason: "timeout",
    });

    setErrorReporter(null);
  });

  it("受け皿が無くても落ちない(ローカル開発)", () => {
    const out = capture();
    const log = new JobLogger({}, out.sink, out.sink);
    expect(() => log.error("karte_failed", "文字列を投げられた")).not.toThrow();
    expect(out.parsed()[0]?.["error_name"]).toBe("NonError");
  });
});

describe("describeError", () => {
  it("Errorでないものも構造化する", () => {
    expect(describeError(42)).toEqual({ error_name: "NonError", error_message: "42" });
  });
});
