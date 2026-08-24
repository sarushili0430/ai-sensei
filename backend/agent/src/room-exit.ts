import type { JobLogger } from "./log.ts";

/**
 * 部屋から出られるもの(= `ctx.room`)。LiveKitの型に依存させないための構造型。
 * テストは偽物の部屋1つで足りる。
 */
export type RoomExit = {
  disconnect(): Promise<void>;
};

/**
 * 部屋を出る。**片付けではなく、アプリを次の画面へ進める合図として呼ぶ。**
 *
 * `AgentSession.close()` が閉じるのは声のパイプラインだけで、**参加者としては
 * 部屋に残る**。アプリは「先輩が出ていった」を会話の終わりとして読むので
 * (`session_controller.dart` の `_onSenpaiLeft`)、残ったまま後片付け
 * (復習問題の生成・API への POST)へ進むと、その間ずっと**アプリは止まって見える**。
 *
 * entry を抜けてから出るのでは遅い。抜けたジョブは**部屋が閉じるのを待つ側に回る**
 * (`@livekit/agents` の `job_proc_lazy_main`)ので、アプリが先輩の退室を待ち、
 * 先輩がアプリの退室を待つ — 互いに待つ。解けるのは残り時間が尽きたときだけになる。
 *
 * **出たあとも entry の続きは走る。**ジョブが畳まれるのは entry を抜けてからで、
 * 部屋を出ただけでは止まらない。だから「アプリを待たせない後片付け」は、
 * ここを通してから書ける。
 *
 * 失敗しても投げない。ここで投げると、会話は成立したのに復習問題も `/complete` も
 * 無いまま entry が落ちる — 生徒から見ると「3日後に何も来ない」だけになる。
 * 出られなかったときはアプリ側が残り時間で降りる道に落ちる(遅いが行き止まりではない)。
 */
export async function leaveRoom(room: RoomExit, log: Pick<JobLogger, "warn">): Promise<void> {
  try {
    await room.disconnect();
  } catch (error) {
    log.warn("room_disconnect_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
