import { describe, expect, it, vi } from "vitest";
import { StepPacer, defaultStepPauseMs, pauseBetweenSteps } from "./speech-pace.ts";

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

/**
 * 手順と手順のあいだの間。見たいのは3つ:
 *
 *   1. 実際に黙ること(0にしたら黙らないこと)
 *   2. **降りたい人を足止めしないこと** —「わかった」もセッションの終わりも間を切る
 *   3. 切り上げたあと、タイマも購読も残さないこと(授業は何十手順も回る)
 */
describe("pauseBetweenSteps", () => {
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

/**
 * 目標まで**埋める**係。ここが見たいのは、固定の沈黙を足していた版との差
 * ——「間隔を開けすぎて、文章が途切れになってしまう」を作っていたのは積み上げ。
 */
describe("StepPacer", () => {
  /** 時計を手で握る。実時間に依存すると、この層のテストは必ず不安定になる。 */
  function clock(start = 1_000) {
    let at = start;
    return {
      now: () => at,
      advance: (ms: number) => {
        at += ms;
      },
    };
  }

  it("まだ1手順も読んでいなければ、間を置かない", () => {
    const pacer = new StepPacer({ gapMs: 500, now: clock().now });

    expect(pacer.shortfallMs()).toBe(0);
  });

  it("読み終えた直後は、目標のぶんだけ黙る", () => {
    const time = clock();
    const pacer = new StepPacer({ gapMs: 500, now: time.now });

    pacer.markSpoken();

    expect(pacer.shortfallMs()).toBe(500);
  });

  /**
   * これが本体。手順のあいだにはもともと沈黙がある(板書LLMの生成待ち・検証・
   * 合成待ち)。そこへ固定の間を足していたので、遅い手順ほど間が延びていた。
   */
  it("すでに空いたぶんを差し引く", () => {
    const time = clock();
    const pacer = new StepPacer({ gapMs: 500, now: time.now });

    pacer.markSpoken();
    time.advance(300);

    expect(pacer.shortfallMs()).toBe(200);
  });

  it("目標より長く空いていれば、1ミリ秒も足さない", () => {
    const time = clock();
    const pacer = new StepPacer({ gapMs: 500, now: time.now });

    pacer.markSpoken();
    // 生徒が答えているあいだ(次のパスの1手順目)は、どのみち目標を超えている。
    time.advance(9_000);

    expect(pacer.shortfallMs()).toBe(0);
  });

  it("0なら常に間を置かない", () => {
    const time = clock();
    const pacer = new StepPacer({ gapMs: 0, now: time.now });

    pacer.markSpoken();

    expect(pacer.shortfallMs()).toBe(0);
  });

  it("起点は読み終えるたびに引き直す", () => {
    const time = clock();
    const pacer = new StepPacer({ gapMs: 500, now: time.now });

    pacer.markSpoken();
    time.advance(400);
    pacer.markSpoken();

    expect(pacer.shortfallMs()).toBe(500);
  });

  it("wait は足りないぶんだけ黙り、止める合図で切り上げる", async () => {
    await withFakeTimers(async () => {
      const pacer = new StepPacer({ gapMs: 500 });
      pacer.markSpoken();
      await vi.advanceTimersByTimeAsync(200);

      const waiting = pacer.wait();
      await vi.advanceTimersByTimeAsync(299);
      expect(await settled(waiting)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settled(waiting)).toBe(true);

      pacer.markSpoken();
      const understood = new AbortController();
      const cut = pacer.wait([understood.signal]);
      understood.abort();
      expect(await settled(cut)).toBe(true);
    });
  });
});
