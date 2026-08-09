import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureFileNames, fixtureFileSchemas, fixturePath, fixtureSchemas } from "./fixtures.ts";
import {
  boardChannelLogSchema,
  boardChannelMessageSchema,
  boardLessonSchema,
  boardLessonStepsMaxCount,
  boardSpeechMaxLength,
  boardStepSchema,
  boardStepsMaxCount,
  boardTexMaxLength,
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
    expect(fixtureFileNames).toContain("board-lesson.en");
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

describe("板書のスキーマ", () => {
  /** 有効な手順1つ。壊し方だけをテストごとに変える。 */
  function step(overrides: Record<string, unknown> = {}) {
    return {
      index: 0,
      speech: "ここ、D を見てほしいんだけど — プラスだよね。だから?",
      board: { kind: "latex", tex: "D = 1 > 0" },
      ...overrides,
    };
  }

  function lesson(steps: unknown[]) {
    return { title: "判別式で解の個数を見る", topic_ids: ["M1-NIJI-HANBETSU"], steps };
  }

  // 音声は問いかけと接続だけ(§3-1)。原則をプロンプトではなくスキーマで守る。
  // ここを緩めるとTTS原価が線形に増える。
  it("speechが長すぎる手順を弾く(1手順=20〜25秒)", () => {
    expect(boardSpeechMaxLength).toBe(120);
    expect(boardStepSchema.safeParse(step({ speech: "あ".repeat(120) })).success).toBe(true);
    expect(boardStepSchema.safeParse(step({ speech: "あ".repeat(121) })).success).toBe(false);
  });

  it("speechに数式(LaTeX)を書かせない", () => {
    expect(boardStepSchema.safeParse(step({ speech: "D は \\frac{1}{2} だよね" })).success).toBe(
      false,
    );
  });

  it("board が null の手順は有効(相づち・確認)", () => {
    expect(boardStepSchema.safeParse(step({ board: null })).success).toBe(true);
  });

  // 板書は「1手順=1行」であって、答案の貼り付け場所ではない。
  // 1要素の上限・多行環境の禁止・手順数の上限の3つで塞ぐ。
  it("解答を丸ごと1要素に流し込めない", () => {
    expect(
      boardStepSchema.safeParse(
        step({ board: { kind: "latex", tex: "x = 1".repeat(boardTexMaxLength) } }),
      ).success,
    ).toBe(false);
    expect(
      boardStepSchema.safeParse(
        step({ board: { kind: "latex", tex: "\\begin{align} a &= 1 \\\\ b &= 2 \\end{align}" } }),
      ).success,
    ).toBe(false);
    expect(
      boardStepSchema.safeParse(step({ board: { kind: "text", body: "解説".repeat(100) } }))
        .success,
    ).toBe(false);
  });

  // 上限は**1回の出力**にかかる(板書1枚の上限 boardStepsMaxCount とは別物)。
  // 1回でこれを超えるなら、それは板書ではなく答案。
  it("1回の出力に手順を詰め込みすぎた板書を弾く(1行ずつ40行という抜け道を塞ぐ)", () => {
    const steps = Array.from({ length: boardLessonStepsMaxCount + 1 }, (_, index) =>
      step({ index }),
    );
    expect(boardLessonSchema.safeParse(lesson(steps)).success).toBe(false);
  });

  it("indexが飛んだ板書を弾く(受信側が欠落と区別できないため)", () => {
    expect(
      boardLessonSchema.safeParse(lesson([step({ index: 0 }), step({ index: 2 })])).success,
    ).toBe(false);
  });

  // 自由描画をさせない。プリミティブを固定し、パラメータだけ吐かせる。
  it("知らない種類の板書要素を弾く", () => {
    expect(
      boardStepSchema.safeParse(step({ board: { kind: "svg", d: "M0 0 L10 10" } })).success,
    ).toBe(false);
    expect(
      boardStepSchema.safeParse(step({ board: { kind: "latex", tex: "x", note: "余計" } })).success,
    ).toBe(false);
  });

  it("座標が有限でない図形を弾く", () => {
    const circle = { kind: "circle", center: { x: 0, y: Number.POSITIVE_INFINITY }, r: 5 };
    expect(boardStepSchema.safeParse(step({ board: circle })).success).toBe(false);
  });

  it("plotのfnは既定の文字と関数名しか受け付けない(端末上で評価するため)", () => {
    const plot = (fn: string) => ({ kind: "plot", fn, domain: { min: -1, max: 4 } });
    expect(boardStepSchema.safeParse(step({ board: plot("x^2 - 3*x + 2") })).success).toBe(true);
    expect(boardStepSchema.safeParse(step({ board: plot("sqrt(x) + 1") })).success).toBe(true);
    expect(boardStepSchema.safeParse(step({ board: plot("process.exit()") })).success).toBe(false);
  });

  it("plotのdomainは min < max", () => {
    const plot = { kind: "plot", fn: "x^2", domain: { min: 4, max: -1 } };
    expect(boardStepSchema.safeParse(step({ board: plot })).success).toBe(false);
  });

  // 封筒(data channel)とLLM出力は別物。混ぜると幻覚したIDが配送層に流れ込む。
  it("LLMの出す板書に session_id / board_id を持たせない", () => {
    const withIds = { ...lesson([step()]), session_id: "ses_1", board_id: "brd_1" };
    expect(boardLessonSchema.safeParse(withIds).success).toBe(false);
  });

  describe("data channel の封筒", () => {
    function log() {
      return JSON.parse(JSON.stringify(loadFixture("board-channel-log"))) as {
        messages: Record<string, unknown>[];
      };
    }

    it("1セッションで複数の板書を扱える(board_idで切り替える)", () => {
      const boardIds = new Set(log().messages.map((message) => message["board_id"]));
      expect(boardIds.size).toBe(2);
    });

    it("seqが飛んだら欠落として弾く", () => {
      const broken = log();
      broken.messages[2]!["seq"] = 9;
      expect(boardChannelLogSchema.safeParse(broken).success).toBe(false);
    });

    it("手順が抜けたら弾く(indexは板書ごとに0始まりで1ずつ)", () => {
      const broken = log();
      broken.messages.splice(2, 1);
      broken.messages.forEach((message, seq) => {
        message["seq"] = seq;
      });
      expect(boardChannelLogSchema.safeParse(broken).success).toBe(false);
    });

    it("step_countが実際の手順数と合わなければ弾く(末尾の欠落の検知)", () => {
      const broken = log();
      broken.messages[4]!["step_count"] = 5;
      expect(boardChannelLogSchema.safeParse(broken).success).toBe(false);
    });

    it("board_openされていない板書の手順を弾く", () => {
      const broken = log();
      broken.messages[1]!["board_id"] = "brd_未開封";
      expect(boardChannelLogSchema.safeParse(broken).success).toBe(false);
    });

    /**
     * **板書の寿命は「1回の説明」ではなく「1つの問題」。**
     * 1回のLLM出力に12手順の上限があるのは「答案を一度に流し込ませない」ためで、
     * 板書1枚の上限とは別物。両者を同じ数にすると、**会話が1往復するたびに
     * 板書を開き直す**しかなくなり、§3-2 の「前の行は消さない」が毎ターン破れる。
     */
    it("ワイヤーの index は1回の出力の上限を超えられる(板書は問題ぶん続く)", () => {
      expect(boardStepsMaxCount).toBeGreaterThan(boardLessonStepsMaxCount);

      const message = {
        v: 1,
        session_id: "ses_1",
        board_id: "brd_1",
        seq: 0,
        type: "board_step",
        step: {
          index: boardLessonStepsMaxCount,
          speech: "じゃあ、続きね。",
          board: { kind: "latex", tex: "x = 1" },
        },
      };
      expect(boardChannelMessageSchema.safeParse(message).success).toBe(true);

      // ただし板書1枚の上限は超えられない(打ち切りの安全弁)
      const overflow = {
        ...message,
        step: { ...message.step, index: boardStepsMaxCount },
      };
      expect(boardChannelMessageSchema.safeParse(overflow).success).toBe(false);
    });

    it("step_count も板書1枚ぶんの合計として受け付ける", () => {
      const close = {
        v: 1,
        session_id: "ses_1",
        board_id: "brd_1",
        seq: 0,
        type: "board_close",
        step_count: boardStepsMaxCount,
        reason: "completed",
      };
      expect(boardChannelMessageSchema.safeParse(close).success).toBe(true);
      expect(
        boardChannelMessageSchema.safeParse({ ...close, step_count: boardStepsMaxCount + 1 })
          .success,
      ).toBe(false);
    });

    it("知らない種類の封筒を弾く", () => {
      const message = {
        v: 1,
        session_id: "ses_1",
        board_id: "brd_1",
        seq: 0,
        type: "board_clear",
      };
      expect(boardChannelMessageSchema.safeParse(message).success).toBe(false);
    });
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
