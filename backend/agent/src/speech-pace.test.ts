import { describe, expect, it, vi } from "vitest";
import { defaultStepPauseMs, pauseBetweenSteps } from "./speech-pace.ts";

/**
 * 手順と手順のあいだの間。見たいのは3つ:
 *
 *   1. 実際に黙ること(0にしたら黙らないこと)
 *   2. **降りたい人を足止めしないこと** —「わかった」もセッションの終わりも間を切る
 *   3. 切り上げたあと、タイマも購読も残さないこと(授業は何十手順も回る)
 */
describe("pauseBetweenSteps", () => {
  /** 進めた時間だけを見る。実時間で待つと、テストがそのまま遅くなる。 */
  async function withFakeTimers(body: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  /** まだ解決していないことを、マイクロタスクを1周させてから確かめる。 */
  function settled(promise: Promise<void>): Promise<boolean> {
    return Promise.race([promise.then(() => true), Promise.resolve().then(() => false)]);
  }

  it("指定した時間だけ黙る", async () => {
    await withFakeTimers(async () => {
      const pause = pauseBetweenSteps(700);

      await vi.advanceTimersByTimeAsync(699);
      expect(await settled(pause)).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await settled(pause)).toBe(true);
    });
  });

  // 0 は「間を置かない」の明示。従来どおり切れ目なく続く。
  it("0以下ならその場で返る", async () => {
    await expect(pauseBetweenSteps(0)).resolves.toBeUndefined();
    await expect(pauseBetweenSteps(-1)).resolves.toBeUndefined();
  });

  // 沈黙は「読ませる時間」であって「待たせる時間」ではない。
  it("止める合図が来たら、その瞬間に切り上げる", async () => {
    await withFakeTimers(async () => {
      const understood = new AbortController();
      const pause = pauseBetweenSteps(5000, [new AbortController().signal, understood.signal]);

      await vi.advanceTimersByTimeAsync(10);
      expect(await settled(pause)).toBe(false);

      understood.abort();
      expect(await settled(pause)).toBe(true);
    });
  });

  it("もう落ちている合図なら、待たずに返る", async () => {
    const ended = new AbortController();
    ended.abort();
    await expect(pauseBetweenSteps(5000, [ended.signal])).resolves.toBeUndefined();
  });

  // 授業は何十手順も回る。1手順ごとに購読が積み残ると、そのまま漏れる。
  it("終わったら購読を外す", async () => {
    await withFakeTimers(async () => {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");

      await Promise.all([
        pauseBetweenSteps(100, [controller.signal]),
        vi.advanceTimersByTimeAsync(100),
      ]);

      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });

  it("既定は0より大きい(間を置かないのは明示したときだけ)", () => {
    expect(defaultStepPauseMs).toBeGreaterThan(0);
  });
});
