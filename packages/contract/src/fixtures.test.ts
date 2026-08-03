import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureNames, fixturePath, fixtureSchemas } from "./fixtures.ts";
import {
  completeSessionRequestSchema,
  createSessionResponseSchema,
  karteDraftSchema,
  karteSchema,
} from "./index.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(repoRoot, `packages/contract/fixtures/${name}.json`), "utf8"),
  );
}

describe("fixture", () => {
  // Flutter側のテストも同じファイルを読む。両側が通れば契約は揃っている。
  it.each(fixtureNames)("%s.json が対応スキーマを満たす", (name) => {
    const parsed = fixtureSchemas[name].safeParse(loadFixture(name));
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("fixturePath がリポジトリ相対パスを返す", () => {
    expect(fixturePath("karte")).toBe("packages/contract/fixtures/karte.json");
    expect(() => readFileSync(resolve(repoRoot, fixturePath("karte")))).not.toThrow();
  });
});

describe("カルテのスキーマ", () => {
  it("点数・正答率のフィールドを受け付けない(strict)", () => {
    const withScore = { ...(loadFixture("karte") as object), score: 82 };
    expect(karteSchema.safeParse(withScore).success).toBe(false);
  });

  it("穴が0件のカルテも有効(全部言えた日)", () => {
    const draft = { said_well: ["最初の一歩の理由を説明できた"], holes: [], term_notes: [] };
    expect(karteDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("穴は5件までに制限する(責める道具にしないため)", () => {
    const draft = {
      said_well: [],
      term_notes: [],
      holes: Array.from({ length: 6 }, () => ({
        topic_id: "M1-NIJI-HANBETSU",
        desc: "説明が止まった",
        severity: "low" as const,
      })),
    };
    expect(karteDraftSchema.safeParse(draft).success).toBe(false);
  });

  it("形の壊れたtopic_idを弾く", () => {
    const draft = {
      said_well: [],
      term_notes: [],
      holes: [{ topic_id: "線形代数", desc: "説明が止まった", severity: "low" }],
    };
    expect(karteDraftSchema.safeParse(draft).success).toBe(false);
  });

  it("followup_question は省略可(無料ユーザーには生成しない)", () => {
    const draft = { said_well: [], holes: [], term_notes: [] };
    expect(karteDraftSchema.parse(draft).followup_question).toBeUndefined();
  });
});

describe("APIスキーマ", () => {
  it("detected_topics が空のセッション作成レスポンスは無効", () => {
    const response = loadFixture("create-session-response") as Record<string, unknown>;
    expect(
      createSessionResponseSchema.safeParse({ ...response, detected_topics: [] }).success,
    ).toBe(false);
  });

  it("transcriptのroleは assistant / user のみ", () => {
    const request = loadFixture("complete-session-request") as {
      transcript: { role: string }[];
    };
    for (const message of request.transcript) {
      expect(["assistant", "user"]).toContain(message.role);
    }

    const withSystem = {
      ...request,
      transcript: [...request.transcript, { role: "system", text: "x", at_ms: 0 }],
    };
    expect(completeSessionRequestSchema.safeParse(withSystem).success).toBe(false);
  });

  it("途中で切れたセッションも受け付ける(ended_reason)", () => {
    const request = loadFixture("complete-session-request") as Record<string, unknown>;
    expect(
      completeSessionRequestSchema.safeParse({ ...request, ended_reason: "timeout" }).success,
    ).toBe(true);
    expect(
      completeSessionRequestSchema.safeParse({ ...request, ended_reason: "gave_up" }).success,
    ).toBe(false);
  });
});
