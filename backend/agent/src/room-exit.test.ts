import { describe, expect, it, vi } from "vitest";
import { leaveRoom } from "./room-exit.ts";

/**
 * 「わかった」を押したのに画面が止まる、の再発を止めるためのテスト。
 *
 * 症状はアプリ側に出るが、原因はここ — agent が**後片付けの前に部屋を出るか**
 * どうか。出ないと、アプリは「先輩が出ていった」を受け取れないまま
 * 上限時間まで待たされる(出口はその間ずっと塞がっている)。
 */
describe("leaveRoom", () => {
  it("部屋を出る", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    await leaveRoom({ disconnect }, { warn });

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * 出られなくても、呼び出し側は復習問題の生成と `/complete` へ進めること。
   * ここで投げると、会話は成立したのに3日後に何も届かないセッションになる。
   */
  it("出られなくても投げず、理由だけ残す", async () => {
    const disconnect = vi.fn().mockRejectedValue(new Error("already disconnected"));
    const warn = vi.fn();

    await expect(leaveRoom({ disconnect }, { warn })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("room_disconnect_failed", {
      message: "already disconnected",
    });
  });
});
