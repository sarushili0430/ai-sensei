import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureFileNames, fixtureFileSchemas, fixturePath, fixtureSchemas } from "./fixtures.ts";
import {
  completeSessionRequestSchema,
  createSessionRequestSchema,
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
  it.each(fixtureFileNames)("%s.json が対応スキーマを満たす", (name) => {
    const schema = fixtureSchemas[fixtureFileSchemas[name] as keyof typeof fixtureSchemas];
    const parsed = schema.safeParse(loadFixture(name));
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  // 海外向けの課程のfixtureが消えると、英語のセッションのかたちを
  // 誰も検査しなくなる(接頭辞を変えた瞬間に気づけない)。
  it("日本の課程と海外の課程、両方のかたちを持っている", () => {
    expect(fixtureFileNames).toContain("karte");
    expect(fixtureFileNames).toContain("karte.en");
    expect(fixtureFileNames).toContain("create-session-response.en");
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

  // status と filled_at がずれると、復習キューと埋めた穴カウンターが
  // 食い違った数字を出す
  it("open な穴に filled_at が入っていたら弾く", () => {
    const karte = loadFixture("karte") as { holes: Record<string, unknown>[] };
    const broken = {
      ...karte,
      holes: [{ ...karte.holes[0], status: "open", filled_at: "2026-08-04T11:00:00.000Z" }],
    };
    expect(karteSchema.safeParse(broken).success).toBe(false);
  });

  it("filled な穴に filled_at がなければ弾く", () => {
    const karte = loadFixture("karte") as { holes: Record<string, unknown>[] };
    const broken = {
      ...karte,
      holes: [{ ...karte.holes[0], status: "filled", filled_at: null }],
    };
    expect(karteSchema.safeParse(broken).success).toBe(false);
  });

  it("followup_question は省略可(無料ユーザーには生成しない)", () => {
    const draft = { said_well: [], holes: [], term_notes: [] };
    expect(karteDraftSchema.parse(draft).followup_question).toBeUndefined();
  });
});

describe("APIスキーマ", () => {
  it("kind=review には hole_id が要る(復習は穴が起点)", () => {
    expect(createSessionRequestSchema.safeParse({ kind: "review" }).success).toBe(false);
    expect(createSessionRequestSchema.safeParse({ kind: "review", hole_id: "hol_1" }).success).toBe(
      true,
    );
  });

  it("kind と locale は省略できる(既定は new / ja)", () => {
    const parsed = createSessionRequestSchema.parse({});
    expect(parsed.kind).toBe("new");
    expect(parsed.locale).toBe("ja");
  });

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
