import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory.ts";
import type {
  KarteRecord,
  PracticeAttemptRecord,
  PracticeProblemRecord,
  SessionRecord,
} from "./types.ts";

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    device_id: "device_a",
    kind: "new",
    status: "open",
    created_at: "2026-08-03T13:24:07.000Z",
    completed_at: null,
    local_date: "2026-08-03",
    photo_key: null,
    topic_ids: [],
    hole_id: null,
    practice_problem_id: null,
    duration_seconds: null,
    context: null,
    started_at: null,
    max_seconds: null,
    quota_settled_at: null,
    analysis_count: 1,
    ...overrides,
  };
}

function practiceProblem(
  id: string,
  overrides: Partial<PracticeProblemRecord> = {},
): PracticeProblemRecord {
  return {
    id,
    device_id: "device_a",
    session_id: `session_${id}`,
    board_id: `board_${id}`,
    topic_id: "M1-NIJI-HANBETSU",
    question: "判別式の符号から何がわかる?",
    answer: "実数解の個数",
    created_at: "2026-08-03T13:24:07.000Z",
    ...overrides,
  };
}

function practiceAttempt(
  id: string,
  problemId: string,
  overrides: Partial<PracticeAttemptRecord> = {},
): PracticeAttemptRecord {
  return {
    id,
    problem_id: problemId,
    answered_at: "2026-08-03T13:24:07.000Z",
    response: "判別式の符号で実数解の個数がわかる",
    verdict: "correct",
    graded_by: "stub",
    comment: "いいね",
    ...overrides,
  };
}

/** 解析の枠(行を作れるか)。授業の枠とは別で、こちらはずっと緩い。 */
describe("MemoryRepository.createSession", () => {
  it("その日の解析の上限に達したら作らない", async () => {
    const repository = new MemoryRepository();
    const created = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        repository.createSession({
          session: session(`session_${index}`),
          maxAnalysesPerDay: 2,
        }),
      ),
    );

    expect(created).toEqual([true, true, false]);
    expect(repository.sessions.size).toBe(2);
  });

  it("会話を始めていない行も、解析の上限には数える(原価は解析で発生する)", async () => {
    const repository = new MemoryRepository();
    await repository.createSession({ session: session("analyzed"), maxAnalysesPerDay: 1 });

    expect(await repository.getDailySessionUsage("device_a", "2026-08-03")).toEqual({
      consumedSeconds: 0,
      sessionsStarted: 0,
    });
    expect(
      await repository.createSession({ session: session("second"), maxAnalysesPerDay: 1 }),
    ).toBe(false);
  });

  it("解析失敗で行を消せば、同じ日にもう一度作れる", async () => {
    const repository = new MemoryRepository();
    expect(
      await repository.createSession({ session: session("failed"), maxAnalysesPerDay: 1 }),
    ).toBe(true);

    await repository.deleteSession("failed");

    expect(
      await repository.createSession({ session: session("retried"), maxAnalysesPerDay: 1 }),
    ).toBe(true);
    expect(repository.sessions.size).toBe(1);
  });

  it("会話中に足した解析も、次のセッション作成の日次上限へ合算する", async () => {
    const repository = new MemoryRepository();
    await repository.createSession({
      session: session("started", { started_at: "2026-08-03T13:30:00.000Z" }),
      maxAnalysesPerDay: 99,
    });
    expect(
      await repository.reserveSessionAnalysis({
        sessionId: "started",
        deviceId: "device_a",
        localDate: "2026-08-03",
        maxAnalysesPerSession: 5,
        maxAnalysesPerDay: 2,
      }),
    ).toBe(true);

    expect(
      await repository.createSession({
        session: session("over_limit"),
        maxAnalysesPerDay: 2,
      }),
    ).toBe(false);
  });
});

/**
 * 授業の枠 = 日次の持ち時間からその回の `max_seconds` を仮押さえすること。
 * 確認と書き込みの間にawaitを足すと、同時呼び出しが同じ残高を見てこのテストが落ちる。
 */
describe("MemoryRepository.startSession", () => {
  async function seed(repository: MemoryRepository, ids: string[], device = "device_a") {
    for (const id of ids) {
      await repository.createSession({
        session: session(id, { device_id: device }),
        maxAnalysesPerDay: 99,
      });
    }
  }

  function start(
    repository: MemoryRepository,
    id: string,
    options: {
      device?: string;
      localDate?: string;
      startedAt?: string;
      secondsPerDay?: number;
      sessionMaxSeconds?: number;
      minimumSessionSeconds?: number;
      maxStartsPerDay?: number;
    } = {},
  ) {
    return repository.startSession({
      sessionId: id,
      deviceId: options.device ?? "device_a",
      startedAt: options.startedAt ?? "2026-08-03T13:24:07.000Z",
      localDate: options.localDate ?? "2026-08-03",
      secondsPerDay: options.secondsPerDay ?? 1200,
      sessionMaxSeconds: options.sessionMaxSeconds ?? 1200,
      minimumSessionSeconds: options.minimumSessionSeconds ?? 180,
      maxStartsPerDay: options.maxStartsPerDay ?? 20,
    });
  }

  it("1200秒の枠は、同時に3本始めて1本だけ確保できる", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a", "b", "c"]);

    const results = await Promise.all(["a", "b", "c"].map((id) => start(repository, id)));

    expect(results.filter((result) => result.started)).toHaveLength(1);
    expect(await repository.getDailySessionUsage("device_a", "2026-08-03")).toEqual({
      consumedSeconds: 1200,
      sessionsStarted: 1,
    });
  });

  it("残高1800秒を同時に取り合っても1200秒と600秒に分かれ、三重取りしない", async () => {
    const repository = new MemoryRepository();
    const ids = ["a", "b", "c"];
    await seed(repository, ids);

    const results = await Promise.all(
      ids.map((id) => start(repository, id, { secondsPerDay: 1800 })),
    );

    expect(results.map((result) => (result.started ? result.maxSeconds : null))).toEqual([
      1200,
      600,
      null,
    ]);
    expect(await repository.getDailySessionUsage("device_a", "2026-08-03")).toEqual({
      consumedSeconds: 1800,
      sessionsStarted: 2,
    });
  });

  it("完了実績で未使用分を返し、残り600秒を次の max_seconds にする", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a", "b"]);
    expect((await start(repository, "a")).started).toBe(true);
    await repository.completeSession({
      sessionId: "a",
      completedAt: "2026-08-03T13:34:07.000Z",
      durationSeconds: 600,
    });

    expect(await start(repository, "b")).toMatchObject({
      started: true,
      maxSeconds: 600,
      remainingSecondsToday: 0,
    });
  });

  it("残高179秒では始めず、180秒の境界はそのまま配る", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["used", "denied", "allowed"]);
    repository.sessions.set(
      "used",
      session("used", {
        status: "completed",
        started_at: "2026-08-03T12:00:00.000Z",
        max_seconds: 1200,
        duration_seconds: 1021,
        completed_at: "2026-08-03T12:17:01.000Z",
        quota_settled_at: "2026-08-03T12:17:01.000Z",
      }),
    );

    expect(await start(repository, "denied")).toEqual({ started: false });
    repository.sessions.set("used", {
      ...repository.sessions.get("used")!,
      duration_seconds: 1020,
    });
    expect(await start(repository, "allowed")).toMatchObject({
      started: true,
      maxSeconds: 180,
    });
  });

  it("残高があっても非公開の開始回数ガードを越えない", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a", "b"]);
    const guarded = {
      secondsPerDay: 3600,
      sessionMaxSeconds: 180,
      maxStartsPerDay: 1,
    };

    expect((await start(repository, "a", guarded)).started).toBe(true);
    expect(await start(repository, "b", guarded)).toEqual({ started: false });
  });

  it("同じセッションを2度始めても仮押さえを重ねない", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);

    expect(await start(repository, "a")).toEqual({
      started: true,
      alreadyStarted: false,
      sessionsToday: 1,
      maxSeconds: 1200,
      remainingSecondsToday: 0,
    });
    expect(await start(repository, "a")).toEqual({
      started: true,
      alreadyStarted: true,
      sessionsToday: 1,
      maxSeconds: 1200,
      remainingSecondsToday: 0,
    });
  });

  it("JSTの日付をまたいだセッションは、会話が始まった翌日の時間に数える", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);

    await start(repository, "a", {
      startedAt: "2026-08-03T15:10:00.000Z",
      localDate: "2026-08-04",
    });

    expect((await repository.getDailySessionUsage("device_a", "2026-08-03")).consumedSeconds).toBe(
      0,
    );
    expect((await repository.getDailySessionUsage("device_a", "2026-08-04")).consumedSeconds).toBe(
      1200,
    );
  });

  it("他人のセッションは始められない", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);

    expect(await start(repository, "a", { device: "device_b" })).toEqual({ started: false });
  });

  it("device_idが違えば別の枠", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);
    await seed(repository, ["b"], "device_b");

    expect((await start(repository, "a")).started).toBe(true);
    expect((await start(repository, "b", { device: "device_b" })).started).toBe(true);
  });

  it("/complete が来ない回は max_seconds + grace を過ぎたら仮押さえ額で自動精算する", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);
    await start(repository, "a", { startedAt: "2026-08-03T13:00:00.000Z" });

    expect(
      await repository.settleExpiredSessions({
        deviceId: "device_a",
        now: "2026-08-03T13:22:00.000Z",
        graceSeconds: 120,
      }),
    ).toBe(0);
    expect(
      await repository.settleExpiredSessions({
        deviceId: "device_a",
        now: "2026-08-03T13:22:01.000Z",
        graceSeconds: 120,
      }),
    ).toBe(1);
    expect(repository.sessions.get("a")).toMatchObject({
      duration_seconds: 1200,
      quota_settled_at: "2026-08-03T13:22:01.000Z",
    });
  });

  /**
   * **自動精算は満額の仮押さえであって、実績ではない。**
   *
   * 落ちた agent が戻って `/complete` を送り直す窓(`canReissueToken` と同じ考え方)が
   * あるので、精算のあとに本当の長さが届く回がある。そこで満額を守ってしまうと、
   * 5分で切れた生徒から20分ぶん取ったままになる —— 「短く使うと損」を直しに来た
   * 変更で、同じ損を別の形で作ることになる。**遅れて届いた実績が正本。**
   */
  it("自動精算のあとに実績が届いたら上書きし、使わなかったぶんを残高へ返す", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a", "b"]);
    await start(repository, "a", { startedAt: "2026-08-03T13:00:00.000Z" });
    await repository.settleExpiredSessions({
      deviceId: "device_a",
      now: "2026-08-03T13:22:01.000Z",
      graceSeconds: 120,
    });
    expect(repository.sessions.get("a")?.duration_seconds).toBe(1200);

    await repository.completeSession({
      sessionId: "a",
      completedAt: "2026-08-03T13:23:00.000Z",
      durationSeconds: 300,
    });

    expect(await start(repository, "b", { startedAt: "2026-08-03T13:30:00.000Z" })).toMatchObject({
      started: true,
      maxSeconds: 900,
    });
  });
});

describe("MemoryRepositoryの復習問題", () => {
  it("所有者の問題だけを古い順に返し、セッションからも同じ1問を引ける", async () => {
    const repository = new MemoryRepository();
    await repository.insertPracticeProblem(
      practiceProblem("prb_new", { created_at: "2026-08-03T11:00:00.000Z" }),
    );
    await repository.insertPracticeProblem(
      practiceProblem("prb_old", { created_at: "2026-08-01T11:00:00.000Z" }),
    );
    await repository.insertPracticeProblem(
      practiceProblem("prb_other", {
        device_id: "device_b",
        created_at: "2026-07-31T11:00:00.000Z",
      }),
    );

    expect((await repository.listPracticeProblems("device_a")).map((entry) => entry.id)).toEqual([
      "prb_old",
      "prb_new",
    ]);
    expect(await repository.getPracticeProblemBySession("session_prb_old")).toEqual(
      practiceProblem("prb_old", { created_at: "2026-08-01T11:00:00.000Z" }),
    );
  });

  /**
   * 解答は問題の所有者を通して絞らないと、別端末の本文が親レポートの引用へ
   * 混ざる。直近判定も時系列を前提にするので、保存順ではなく回答時刻で並べる。
   */
  it("解答履歴を所有者で分け、古い順に返す", async () => {
    const repository = new MemoryRepository();
    await repository.insertPracticeProblem(practiceProblem("prb_owned"));
    await repository.insertPracticeProblem(practiceProblem("prb_other", { device_id: "device_b" }));
    await repository.insertPracticeAttempt(
      practiceAttempt("att_new", "prb_owned", {
        answered_at: "2026-08-03T12:00:00.000Z",
      }),
    );
    await repository.insertPracticeAttempt(
      practiceAttempt("att_other", "prb_other", {
        answered_at: "2026-08-01T12:00:00.000Z",
      }),
    );
    await repository.insertPracticeAttempt(
      practiceAttempt("att_old", "prb_owned", {
        answered_at: "2026-08-02T12:00:00.000Z",
        verdict: "incorrect",
      }),
    );

    expect((await repository.listPracticeAttempts("device_a")).map((entry) => entry.id)).toEqual([
      "att_old",
      "att_new",
    ]);
  });

  /** 正解後も作成時の予約を取り消さないので、保存操作は常に足すだけにする。 */
  it("通知予約を取り消さず追加し、予定時刻の古い順に返す", async () => {
    const repository = new MemoryRepository();
    await repository.insertPracticeSchedules([
      {
        id: "psc_7d",
        problem_id: "prb_1",
        step: 3,
        scheduled_at: "2026-08-10T11:00:00.000Z",
        external_id: "os_7d",
      },
    ]);
    await repository.insertPracticeSchedules([
      {
        id: "psc_3d",
        problem_id: "prb_1",
        step: 2,
        scheduled_at: "2026-08-06T11:00:00.000Z",
        external_id: "os_3d",
      },
    ]);

    expect((await repository.listPracticeSchedules("prb_1")).map((entry) => entry.id)).toEqual([
      "psc_3d",
      "psc_7d",
    ]);
    expect(repository.practiceSchedules).toHaveLength(2);
  });
});

describe("MemoryRepository.listKartesOnLocalDates", () => {
  it("UTCの作成日ではなく、セッションのlocal_dateで期間を絞る", async () => {
    const repository = new MemoryRepository();
    await repository.createSession({
      session: session("month_start", {
        local_date: "2026-08-01",
        // UTCでは前日でも、JSTのセッション日としては8月1日。
        created_at: "2026-07-31T15:30:00.000Z",
      }),
      maxAnalysesPerDay: 5,
    });
    await repository.createSession({
      session: session("previous_month", { local_date: "2026-07-31" }),
      maxAnalysesPerDay: 5,
    });

    const karte = (id: string, sessionId: string): KarteRecord => ({
      id,
      session_id: sessionId,
      device_id: "device_a",
      created_at: "2026-07-31T15:30:00.000Z",
      topic_ids: ["M1-NIJI-HANBETSU"],
      said_well: ["判別式の意味を説明した"],
      term_notes: [],
      followup_question: null,
    });
    await repository.insertKarte(karte("kar_august", "month_start"), []);
    await repository.insertKarte(karte("kar_july", "previous_month"), []);

    const result = await repository.listKartesOnLocalDates({
      deviceId: "device_a",
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
    });
    expect(result.map((entry) => entry.id)).toEqual(["kar_august"]);
  });
});
