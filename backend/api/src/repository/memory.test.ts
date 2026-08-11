import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory.ts";
import type { SessionRecord } from "./types.ts";

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
    ...overrides,
  };
}

/**
 * 確認と挿入の間にawaitを足すと、Promise.allの全呼び出しが同じ空きを見てこのテストが落ちる。
 * MemoryRepositoryも本番D1と同じく、枠の確認と行作成を分離できないことを固定する。
 */
describe("MemoryRepository.reserveSessionSlot", () => {
  it("1日1本の枠は同時に3回押さえても1回だけ成功する", async () => {
    const repository = new MemoryRepository();
    const reservations = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        repository.reserveSessionSlot({
          session: session(`session_${index}`),
          maxPerDay: 1,
        }),
      ),
    );

    expect(reservations.filter((reservation) => reservation.reserved)).toHaveLength(1);
    expect(repository.sessions.size).toBe(1);
  });

  it("1日3本の枠は同時に5回押さえると3回成功し、確保後の本数が増える", async () => {
    const repository = new MemoryRepository();
    const reservations = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        repository.reserveSessionSlot({
          session: session(`session_${index}`),
          maxPerDay: 3,
        }),
      ),
    );

    const sessionsToday = reservations.flatMap((reservation) =>
      reservation.reserved ? [reservation.sessionsToday] : [],
    );
    expect(sessionsToday).toEqual([1, 2, 3]);
    expect(repository.sessions.size).toBe(3);
  });

  it("local_dateが違えば別の枠として押さえられる", async () => {
    const repository = new MemoryRepository();
    const first = await repository.reserveSessionSlot({ session: session("first"), maxPerDay: 1 });
    const nextDay = await repository.reserveSessionSlot({
      session: session("next_day", { local_date: "2026-08-04" }),
      maxPerDay: 1,
    });

    expect(first).toEqual({ reserved: true, sessionsToday: 1 });
    expect(nextDay).toEqual({ reserved: true, sessionsToday: 1 });
  });

  it("device_idが違えば別の枠として押さえられる", async () => {
    const repository = new MemoryRepository();
    const first = await repository.reserveSessionSlot({ session: session("first"), maxPerDay: 1 });
    const anotherDevice = await repository.reserveSessionSlot({
      session: session("another_device", { device_id: "device_b" }),
      maxPerDay: 1,
    });

    expect(first).toEqual({ reserved: true, sessionsToday: 1 });
    expect(anotherDevice).toEqual({ reserved: true, sessionsToday: 1 });
  });

  it("解析失敗で行を消せば、同じ日の枠をもう一度押さえられる", async () => {
    const repository = new MemoryRepository();
    expect(
      await repository.reserveSessionSlot({ session: session("failed"), maxPerDay: 1 }),
    ).toEqual({ reserved: true, sessionsToday: 1 });

    await repository.deleteSession("failed");

    expect(
      await repository.reserveSessionSlot({ session: session("retried"), maxPerDay: 1 }),
    ).toEqual({ reserved: true, sessionsToday: 1 });
    expect(repository.sessions.size).toBe(1);
  });
});
