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
  parentReportQuoteMaxCount,
  parentReportQuoteMaxLength,
  parentReportResponseSchema,
  planDayMinutesMax,
  planDaysMaxCount,
  planTurnSchema,
  sessionMetadataSchema,
  studyPlanDraftSchema,
  studyPlanSchema,
  studyRoomVisitMaxSeconds,
  studyRoomVisitRequestSchema,
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
    expect(fixtureFileNames).toContain("study-plan.en");
    expect(fixtureFileNames).toContain("parent-report");
    expect(fixtureFileNames).toContain("parent-report.en");
  });

  it("fixturePath がリポジトリ相対パスを返す", () => {
    expect(fixturePath("karte")).toBe("packages/contract/fixtures/karte.json");
    expect(() => readFileSync(resolve(repoRoot, fixturePath("karte")))).not.toThrow();
  });
});

describe("親レポートのスキーマ", () => {
  function response() {
    return JSON.parse(JSON.stringify(loadFixture("parent-report"))) as {
      requires_premium: boolean;
      report: Record<string, unknown> | null;
    };
  }

  /**
   * 禁止したい概念を「画面で出さない」だけにすると、APIには残り、あとから一行で復活する。
   * 契約が strict で拒否するところまでを、この一覧で固定する。
   */
  it("正答率・理解度スコア・偏差値・学習時間ランキング・他ユーザー比較を受け付けない", () => {
    for (const extra of [
      { accuracy: 0.82 },
      { understanding_score: 73 },
      { deviation_score: 58 },
      { study_time_rank: 4 },
      { percentile: 91 },
    ]) {
      const broken = response();
      broken.report = { ...broken.report, ...extra };
      expect(parentReportResponseSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("数値として持つのは埋めた穴と連続日数だけ", () => {
    const report = response().report;
    expect(report && Object.keys(report).sort()).toEqual([
      "explained_topics",
      "filled_holes",
      "period",
      "quotes",
      "streak_days",
    ]);
  });

  it("本人の引用は件数と文字数の両方を制限する", () => {
    const tooMany = response();
    if (tooMany.report) {
      tooMany.report["quotes"] = Array.from(
        { length: parentReportQuoteMaxCount + 1 },
        (_, index) => `本人の説明 ${index}`,
      );
    }
    expect(parentReportResponseSchema.safeParse(tooMany).success).toBe(false);

    const tooLong = response();
    if (tooLong.report) {
      tooLong.report["quotes"] = ["あ".repeat(parentReportQuoteMaxLength + 1)];
    }
    expect(parentReportResponseSchema.safeParse(tooLong).success).toBe(false);
  });

  it("無料ユーザーは200で返せるが、ロック中の本文は持てない", () => {
    expect(
      parentReportResponseSchema.safeParse({ requires_premium: true, report: null }).success,
    ).toBe(true);

    const leaked = response();
    leaked.requires_premium = true;
    expect(parentReportResponseSchema.safeParse(leaked).success).toBe(false);
  });
});

describe("自習室滞在のスキーマ", () => {
  it("本文は滞在秒数と日付だけに閉じる", () => {
    expect(
      studyRoomVisitRequestSchema.safeParse(loadFixture("study-room-visit-request")).success,
    ).toBe(true);
    expect(
      studyRoomVisitRequestSchema.safeParse({
        ...(loadFixture("study-room-visit-request") as object),
        topic_id: "M1-NIJI-HANBETSU",
      }).success,
    ).toBe(false);
  });

  it("負数・端数・長すぎる申告を弾く", () => {
    for (const duration_seconds of [-1, 0, 1.5, studyRoomVisitMaxSeconds + 1]) {
      expect(
        studyRoomVisitRequestSchema.safeParse({ duration_seconds, visited_on: "2026-08-03" })
          .success,
      ).toBe(false);
    }
  });

  it("見た目だけ日付らしい存在しない日を弾く", () => {
    expect(
      studyRoomVisitRequestSchema.safeParse({
        duration_seconds: 60,
        visited_on: "2026-02-30",
      }).success,
    ).toBe(false);
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

  it("quiz は省略可(出題を持たない旧データも読める)", () => {
    const karte = loadFixture("karte") as { holes: Record<string, unknown>[] };
    const { quiz, ...legacyHole } = karte.holes[0]!;
    expect(quiz).toBeTypeOf("string");
    expect(karteSchema.safeParse({ ...karte, holes: [legacyHole] }).success).toBe(true);
  });

  it("201文字の quiz は弾く(10秒で答えられる1問にする)", () => {
    const draft = {
      said_well: [],
      holes: [
        {
          topic_id: "M1-NIJI-HANBETSU",
          desc: "判別式の意味で説明が止まった",
          severity: "medium" as const,
          quiz: "あ".repeat(201),
        },
      ],
      term_notes: [],
    };
    expect(karteDraftSchema.safeParse(draft).success).toBe(false);
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

describe("学習計画のスキーマ", () => {
  function plan() {
    return JSON.parse(JSON.stringify(loadFixture("study-plan"))) as {
      intake: { exam_date: string; materials: string[] };
      days: { date: string; items: Record<string, unknown>[] }[];
      revisions: Record<string, unknown>[];
    };
  }

  function draft() {
    return JSON.parse(
      JSON.stringify((loadFixture("study-plan-turn") as { plan: unknown }).plan),
    ) as {
      intake: { exam_date: string; materials: string[]; scope: { topic_ids: string[] } };
      days: { date: string; items: Record<string, unknown>[] }[];
      revision: unknown;
    };
  }

  /**
   * 約束2「点数を出さない」は、学習計画でいちばん破られやすい
   * (「目標80点」「今週の達成率」は計画アプリの定番)。しかも §5 の親レポートに
   * 載る前提なので、ここに置いた数字はそのまま親に届く。
   */
  it("目標点・正答率・達成率のフィールドを受け付けない(strict)", () => {
    for (const extra of [{ target_score: 80 }, { accuracy: 0.7 }, { completion_rate: 0.5 }]) {
      expect(studyPlanSchema.safeParse({ ...plan(), ...extra }).success).toBe(false);
    }
  });

  it("割り当ての実績時間も持たせない(親レポートの学習時間ランキングに一歩で届く)", () => {
    const broken = plan();
    broken.days[0]!.items[0]!["actual_minutes"] = 35;
    expect(studyPlanSchema.safeParse(broken).success).toBe(false);
  });

  // テストが終わったあとの日に課題を置く計画は、誰もやらない。
  it("テスト日より後の日には置けない", () => {
    const broken = plan();
    broken.days[broken.days.length - 1]!.date = "2026-09-11";
    expect(studyPlanSchema.safeParse(broken).success).toBe(false);
  });

  // 同じ日が2回出ると画面にその日が二重に並び、どちらが正かを決める根拠がない。
  it("日付が昇順でない・同じ日が2回ある計画を弾く", () => {
    const swapped = plan();
    const first = swapped.days[0]!.date;
    swapped.days[0]!.date = swapped.days[1]!.date;
    swapped.days[1]!.date = first;
    expect(studyPlanSchema.safeParse(swapped).success).toBe(false);

    const duplicated = plan();
    duplicated.days[1]!.date = duplicated.days[0]!.date;
    expect(studyPlanSchema.safeParse(duplicated).success).toBe(false);
  });

  /**
   * `material` を名前ではなく添字にしてある理由そのもの。
   * 文字列だったら「青チャートの例題42」を、青チャートを持っていない生徒に割り当てられる。
   */
  it("聞き取っていない教材を割り当てられない", () => {
    const broken = plan();
    broken.days[0]!.items[0]!["material"] = broken.intake.materials.length;
    expect(studyPlanSchema.safeParse(broken).success).toBe(false);
  });

  it("教材を1つも持っていなくても計画は作れる(教材なしで組む)", () => {
    const noMaterials = draft();
    noMaterials.intake.materials = [];
    for (const day of noMaterials.days) {
      for (const item of day.items) item["material"] = null;
    }
    expect(studyPlanDraftSchema.safeParse(noMaterials).success).toBe(true);
  });

  // 守られなかった計画は「計画は自分には無理だ」だけを教える。
  it("1日に詰め込みすぎた計画を弾く", () => {
    const broken = draft();
    broken.days[0]!.items = [
      { topic_id: "M2-SANKAKU-KAHO", what: "解く", material: null, minutes: 60 },
      { topic_id: "M2-SANKAKU-KAHO", what: "解く", material: null, minutes: 60 },
      { topic_id: "M2-SANKAKU-KAHO", what: "解く", material: null, minutes: 60 },
    ];
    expect(planDayMinutesMax).toBeLessThan(180);
    expect(studyPlanDraftSchema.safeParse(broken).success).toBe(false);
  });

  // 休みの入っていない計画は、最初に崩れた日に丸ごと捨てられる。
  it("休む日(itemsが空)を置ける", () => {
    const rest = draft().days.find((day) => day.items.length === 0);
    expect(rest).toBeDefined();
  });

  it("テストがずっと先の計画は作らない(近づいてから組む)", () => {
    const tooLong = draft();
    tooLong.intake.exam_date = "2027-03-01";
    tooLong.days = Array.from({ length: planDaysMaxCount + 1 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      items: [],
    }));
    expect(studyPlanDraftSchema.safeParse(tooLong).success).toBe(false);
  });

  // 板書と同じ理由。識別子と来歴をLLMに持たせると、幻覚したIDが下流に流れ込む。
  it("LLMの出す計画に id / source / revisions を持たせない", () => {
    for (const extra of [{ id: "pln_1" }, { source: "senpai" }, { revisions: [] }]) {
      expect(studyPlanDraftSchema.safeParse({ ...draft(), ...extra }).success).toBe(false);
    }
  });

  /**
   * 組み直しの理由と引用はLLMが出すが、**時刻は出させない**(いまが何時か知らない)。
   * 押すのは保存側。`id` を持たせないのと同じ理由。
   */
  it("LLMの出す組み直しに時刻を持たせない", () => {
    const rebuilt = { ...draft(), revision: { reason: "behind", said: "3日できなかった" } };
    expect(studyPlanDraftSchema.safeParse(rebuilt).success).toBe(true);

    const withTime = {
      ...rebuilt,
      revision: { ...rebuilt.revision, at: "2026-09-05T20:14:02.000Z" },
    };
    expect(studyPlanDraftSchema.safeParse(withTime).success).toBe(false);
  });

  /**
   * §7「遅れたら落とす順」①の縮退版が**本当に落とせる形か**を固定する。
   * LLMにしか埋められないフィールドが1つでもあると、定型テンプレに落とせなくなる。
   */
  it("定型テンプレでも埋められる(縮退版が同じ形で出せる)", () => {
    const intake = draft().intake; // 聞き取りは縮退版でも同じように取れる
    const template = {
      id: "pln_template",
      created_at: "2026-08-24T12:00:00.000Z",
      source: "template" as const,
      intake,
      days: ["2026-09-01", "2026-09-03", "2026-09-05"].map((date, index) => ({
        date,
        items: [
          {
            topic_id: intake.scope.topic_ids[index % intake.scope.topic_ids.length]!,
            what: "範囲を1周する",
            material: intake.materials.length > 0 ? 0 : null,
            minutes: 40,
            status: "todo" as const,
          },
        ],
      })),
      revisions: [],
    };
    const parsed = studyPlanSchema.safeParse(template);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  /**
   * 組み直しの引用は §5-2「本人の説明の引用」としてそのまま親に届く。
   * 本人が言っていない組み直し(縮退版・アプリ側の判断)は null が正しい。
   */
  it("組み直しの理由は、本人が言っていなければ null にできる", () => {
    const withoutQuote = plan();
    withoutQuote.revisions[0]!["said"] = null;
    expect(studyPlanSchema.safeParse(withoutQuote).success).toBe(true);

    withoutQuote.revisions[0]!["said"] = "";
    expect(studyPlanSchema.safeParse(withoutQuote).success).toBe(false);
  });

  // 事実が変わった組み直しと、進みが変わっただけの組み直しは別物。
  it("知らない組み直しの理由を弾く", () => {
    const broken = plan();
    broken.revisions[0]!["reason"] = "lazy";
    expect(studyPlanSchema.safeParse(broken).success).toBe(false);
  });

  it("テスト日は暦の日付で、瞬間では持たない", () => {
    const broken = plan();
    broken.intake.exam_date = "2026-09-10T00:00:00.000Z";
    expect(studyPlanSchema.safeParse(broken).success).toBe(false);
  });

  /**
   * 計画は聞き取りの会話の途中で生まれる(§4-3)。「テストいつ?」と聞く回と
   * 計画を出す回は同じ形の1ターンで、違いは `plan` が入っているかどうかだけ。
   */
  describe("聞き取りの1ターン", () => {
    it("まだ聞いている途中のターンは plan が null", () => {
      const asking = { speech: "テスト、いつ?", plan: null };
      expect(planTurnSchema.safeParse(asking).success).toBe(true);
    });

    it("喋りすぎるターンを弾く(聞き取りを長引かせない)", () => {
      const turn = loadFixture("study-plan-turn") as Record<string, unknown>;
      expect(planTurnSchema.safeParse({ ...turn, speech: "あ".repeat(121) }).success).toBe(false);
    });

    it("聞き取りのターンに板書を持たせない(聞き取りは授業ではない)", () => {
      const turn = loadFixture("study-plan-turn") as Record<string, unknown>;
      const withBoard = { ...turn, board: { kind: "latex", tex: "x = 1" } };
      expect(planTurnSchema.safeParse(withBoard).success).toBe(false);
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

  /**
   * 写真の問題と復習の穴は別の根拠。新規授業に穴を混ぜるのは弾く一方、
   * 新しいagentを先に出す窓では、古いAPIが作る欄なしの復習も読めなければならない。
   */
  it("session metadata は欄のない旧reviewを読み、新規授業への穴の混入を弾く", () => {
    const metadata = loadFixture("session-metadata") as Record<string, unknown>;
    const reviewHole = {
      topic_id: "M1-NIJI-GURAFU",
      desc: "平方完成の理由で説明が止まった",
      evidence: "形をそろえるため、だと思う",
    };

    expect(sessionMetadataSchema.safeParse(metadata).success).toBe(true);
    const legacyReviewMetadata = JSON.parse(
      JSON.stringify({ ...metadata, kind: "review", review_hole: undefined }),
    ) as Record<string, unknown>;
    expect("review_hole" in legacyReviewMetadata).toBe(false);
    expect(
      sessionMetadataSchema.safeParse(legacyReviewMetadata).success,
      "古いAPIは review_hole というキー自体を送らない",
    ).toBe(true);
    expect(
      sessionMetadataSchema.safeParse({ ...metadata, kind: "review", review_hole: null }).success,
    ).toBe(true);
    expect(
      sessionMetadataSchema.safeParse({ ...metadata, kind: "review", review_hole: reviewHole })
        .success,
    ).toBe(true);
    expect(sessionMetadataSchema.safeParse({ ...metadata, review_hole: reviewHole }).success).toBe(
      false,
    );
  });

  it("detected_topics が空のセッション作成レスポンスは無効", () => {
    const response = loadFixture("create-session-response") as Record<string, unknown>;
    expect(
      createSessionResponseSchema.safeParse({ ...response, detected_topics: [] }).success,
    ).toBe(false);
  });

  it("授業上限は残数を返さず、今日の可否だけを返す", () => {
    const response = loadFixture("create-session-response") as Record<string, unknown>;
    const withRemainingCount = {
      ...response,
      limits: { max_seconds: 300, remaining_sessions_today: 0 },
    };

    // §6-3「UIに数字は一切出さない」を、古い数値契約を拒否することで守る。
    expect(createSessionResponseSchema.safeParse(withRemainingCount).success).toBe(false);
    expect(createSessionResponseSchema.safeParse(response).success).toBe(true);
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

  it("復習結果の自己申告は省略できる", () => {
    const request = loadFixture("complete-session-request") as Record<string, unknown>;
    expect(completeSessionRequestSchema.safeParse(request).success).toBe(true);
  });

  it("復習結果の自己申告に知らない値は受け付けない", () => {
    const request = loadFixture("complete-session-request") as Record<string, unknown>;
    expect(
      completeSessionRequestSchema.safeParse({ ...request, review_outcome: "almost" }).success,
    ).toBe(false);
  });
});
