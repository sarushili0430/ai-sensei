import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory.ts";
import type { KarteRecord, SessionRecord } from "./types.ts";

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
    duration_seconds: null,
    context: null,
    started_at: null,
    analysis_count: 1,
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

    expect(await repository.countStartedSessionsOnDate("device_a", "2026-08-03")).toBe(0);
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
 * 授業の枠 = 会話を1回する権利。
 *
 * 確認と書き込みの間にawaitを足すと、Promise.allの全呼び出しが同じ空きを見てこのテストが落ちる。
 * MemoryRepositoryも本番D1と同じく、枠の確認と記録を分離できないことを固定する。
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

  function start(repository: MemoryRepository, id: string, maxPerDay: number, device = "device_a") {
    return repository.startSession({
      sessionId: id,
      deviceId: device,
      startedAt: "2026-08-03T13:24:07.000Z",
      localDate: "2026-08-03",
      maxPerDay,
    });
  }

  it("1日1本の枠は、同時に3本始めても1本だけ通る", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a", "b", "c"]);

    const results = await Promise.all(["a", "b", "c"].map((id) => start(repository, id, 1)));

    expect(results.filter((result) => result.started)).toHaveLength(1);
    expect(await repository.countStartedSessionsOnDate("device_a", "2026-08-03")).toBe(1);
  });

  it("1日3本の枠は、同時に5本始めると3本通り、確保後の本数が増える", async () => {
    const repository = new MemoryRepository();
    const ids = ["a", "b", "c", "d", "e"];
    await seed(repository, ids);

    const results = await Promise.all(ids.map((id) => start(repository, id, 3)));

    const sessionsToday = results.flatMap((result) =>
      result.started ? [result.sessionsToday] : [],
    );
    expect(sessionsToday).toEqual([1, 2, 3]);
  });

  // つなぎ直し・押し直しで二重に数えないこと。ここが緩むと再接続のたびに枠が減る。
  it("同じセッションを2度始めても数え直さない", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);

    expect(await start(repository, "a", 1)).toEqual({
      started: true,
      alreadyStarted: false,
      sessionsToday: 1,
    });
    expect(await start(repository, "a", 1)).toEqual({
      started: true,
      alreadyStarted: true,
      sessionsToday: 1,
    });
    expect(await repository.countStartedSessionsOnDate("device_a", "2026-08-03")).toBe(1);
  });

  // 撮った日ではなく、始めた日で数える。日付をまたいだセッションは翌日の1本。
  it("数える日は会話が始まった日へ書き直される", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);

    await repository.startSession({
      sessionId: "a",
      deviceId: "device_a",
      startedAt: "2026-08-03T15:10:00.000Z",
      localDate: "2026-08-04",
      maxPerDay: 1,
    });

    expect(await repository.countStartedSessionsOnDate("device_a", "2026-08-03")).toBe(0);
    expect(await repository.countStartedSessionsOnDate("device_a", "2026-08-04")).toBe(1);
  });

  it("他人のセッションは始められない", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);

    expect(await start(repository, "a", 1, "device_b")).toEqual({ started: false });
  });

  it("device_idが違えば別の枠", async () => {
    const repository = new MemoryRepository();
    await seed(repository, ["a"]);
    await seed(repository, ["b"], "device_b");

    expect((await start(repository, "a", 1)).started).toBe(true);
    expect((await start(repository, "b", 1, "device_b")).started).toBe(true);
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
