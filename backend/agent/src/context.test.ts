import type { SessionMetadata } from "@ai-sensei/contract";
import { describe, expect, it } from "vitest";
import {
  InvalidSessionContextError,
  readAgentContext,
  readSessionContext,
  remainingSeconds,
  resolveAgentContext,
  resolveSessionContext,
} from "./context.ts";
import {
  planSessionMetadataFixture,
  planSessionMetadataJson,
  sessionMetadataFixture,
  sessionMetadataJson,
} from "./test-support.ts";

const metadata = sessionMetadataJson();

function withoutField(field: keyof SessionMetadata): string {
  const value: Partial<SessionMetadata> = { ...sessionMetadataFixture };
  delete value[field];
  return JSON.stringify(value);
}

describe("readSessionContext", () => {
  it("contractのfixtureをトークンのmetadataとして読む", () => {
    const context = readSessionContext(metadata);
    expect(context.session_id).toBe(sessionMetadataFixture.session_id);
    expect(context.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
    expect(context.max_seconds).toBe(300);
  });

  // Speaking without context means teaching generalities unrelated to the photo
  it("metadataが空なら会話を始めない", () => {
    expect(() => readSessionContext(undefined)).toThrow(InvalidSessionContextError);
    expect(() => readSessionContext("")).toThrow(InvalidSessionContextError);
  });

  it("JSONでなければ会話を始めない", () => {
    expect(() => readSessionContext("not json")).toThrow(InvalidSessionContextError);
  });

  it("許可トピックが空なら会話を始めない", () => {
    const empty = sessionMetadataJson({ allowed_topic_ids: [] });
    expect(() => readSessionContext(empty)).toThrow(/許可トピックが空/);
  });

  /**
   * `problem_text` and `visible_work` are never filled in on the agent side.
   *
   * The contract (`sessionMetadataSchema`) guarantees `.min(1)`, and backend/api
   * supplies the placeholders - in the conversation's language - for unreadable
   * text and for missing notes. Filling blanks here would create a second place
   * that writes the wording, drifting from the placeholders
   * `senpai_board.<locale>.md` matches by name, so its branch never fires.
   *
   * Missing fields mean a version mismatch, so failing without starting the
   * conversation is correct. Starting a lesson with empty problem text teaches
   * the student an entirely wrong problem.
   */
  it("問題文が欠けていたら会話を始めない", () => {
    expect(() => readSessionContext(withoutField("problem_text"))).toThrow(
      InvalidSessionContextError,
    );
    expect(() => readSessionContext(sessionMetadataJson({ problem_text: "" }))).toThrow(
      InvalidSessionContextError,
    );
  });

  // Even on the no-notes path (a student who photographed only the problem), the
  // contract side sends "(no notes photo)", so it never arrives empty.
  it("ノートの欄が欠けていたら会話を始めない", () => {
    expect(() => readSessionContext(withoutField("visible_work"))).toThrow(
      InvalidSessionContextError,
    );
  });

  it("ノートが無い経路のプレースホルダは、そのまま素通しする", () => {
    const noNotes = sessionMetadataJson({ visible_work: "(ノートの写真なし)" });
    expect(readSessionContext(noNotes).visible_work).toBe("(ノートの写真なし)");
  });

  // `question_seeds` is a required field, but the contract allows an empty string.
  // The wording comes from the same `formatBullets([])` backend/api uses, so it cannot drift.
  it("質問の種が空なら、会話の言語で「なし」を入れる", () => {
    expect(readSessionContext(sessionMetadataJson({ question_seeds: "" })).question_seeds).toBe(
      "(なし)",
    );
    expect(
      readSessionContext(sessionMetadataJson({ locale: "en", question_seeds: "" })).question_seeds,
    ).toBe("(none)");
  });

  // New fixture fields are covered automatically. Adding defaults on the agent side
  // would let a case with the field removed pass and hide contract drift again, so
  // required fields are removed one at a time. Only review_hole is deliberately
  // optional, for the deployment window shared with the old API.
  it("review_hole以外の共有契約の必須項目をagent側で補わない", () => {
    for (const field of Object.keys(sessionMetadataFixture) as (keyof SessionMetadata)[]) {
      if (field === "review_hole") continue;
      expect(() => readSessionContext(withoutField(field)), field).toThrow(
        InvalidSessionContextError,
      );
    }
  });

  it("共有契約にない項目を受け入れない(strict)", () => {
    const extended = JSON.stringify({ ...sessionMetadataFixture, future_field: "x" });
    expect(() => readSessionContext(extended)).toThrow(InvalidSessionContextError);
  });
});

describe("resolveSessionContext", () => {
  it("参加者metadataが読めればそれを使う", () => {
    expect(resolveSessionContext([metadata, undefined]).session_id).toBe(
      sessionMetadataFixture.session_id,
    );
  });

  // On explicit dispatch the context rides on the job
  it("参加者metadataが空でも、ジョブmetadataから読める", () => {
    expect(resolveSessionContext([undefined, metadata]).session_id).toBe(
      sessionMetadataFixture.session_id,
    );
    expect(resolveSessionContext(["", metadata]).session_id).toBe(
      sessionMetadataFixture.session_id,
    );
  });

  it("壊れたmetadataは飛ばして、読めるほうを使う", () => {
    expect(resolveSessionContext(["not json", metadata]).session_id).toBe(
      sessionMetadataFixture.session_id,
    );
  });

  it("どこにも載っていなければ会話を始めない", () => {
    expect(() => resolveSessionContext([undefined, null])).toThrow(InvalidSessionContextError);
    expect(() => resolveSessionContext(["not json", ""])).toThrow(InvalidSessionContextError);
  });
});

describe("remainingSeconds", () => {
  const context = readSessionContext(metadata);
  const startedAt = new Date("2026-08-03T13:00:00.000Z");

  it("経過ぶんを引く", () => {
    expect(remainingSeconds(context, startedAt, new Date("2026-08-03T13:01:00.000Z"))).toBe(240);
  });

  it("超過しても負にならない", () => {
    expect(remainingSeconds(context, startedAt, new Date("2026-08-03T13:10:00.000Z"))).toBe(0);
  });
});

describe("計画セッション文脈", () => {
  it("専用fixtureを授業metadataを緩めずに読める", () => {
    const context = readAgentContext(planSessionMetadataJson());
    expect(context.kind).toBe("plan");
    if (context.kind !== "plan") throw new Error("計画文脈ではありません");
    expect(context.plan_session_id).toBe(planSessionMetadataFixture.plan_session_id);
    expect(context.current_plan).toBeNull();
  });

  it("壊れた計画metadataは会話を始めない", () => {
    expect(() => readAgentContext(planSessionMetadataJson({ max_seconds: 0 }))).toThrow(
      InvalidSessionContextError,
    );
  });

  it("参加者とジョブのどちらに載っても計画を判別する", () => {
    expect(resolveAgentContext([undefined, planSessionMetadataJson()]).kind).toBe("plan");
    expect(resolveAgentContext([sessionMetadataJson(), planSessionMetadataJson()]).kind).toBe(
      "new",
    );
  });
});
