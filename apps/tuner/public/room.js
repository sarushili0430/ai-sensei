/**
 * LiveKit のルームにつなぐ。**`apps/mobile` の `SessionController` の web 版**で、
 * やることは同じ4つ — 接続・マイク公開・先輩の出入りと発話の受け取り・板書の受信。
 *
 * アプリと揃えてある要点(揃えないと、web でだけ再現しない/しなくなる):
 *   - **つなぐ前に** 板書のハンドラを登録する(先輩は入室してすぐ送り始める)
 *   - 封筒の読み出しを**到着順に直列化**する。`readAll()` の完了順は到着順と限らず、
 *     追い越されると受信側の `seq` 検算が**届いているのに欠落**と誤報する
 *   - 先輩が来ないまま25秒経ったら諦める(「聞いています」のまま放置しない)
 */
import {
  ParticipantKind,
  Room,
  RoomEvent,
  Track,
} from "/vendor/livekit-client/livekit-client.esm.mjs";

/** 板書の topic。`packages/contract/src/board.ts` の `boardChannelTopic`。 */
const BOARD_TOPIC = "board";
/** 字幕の topic。`@livekit/agents` の `TOPIC_TRANSCRIPTION`。 */
const TRANSCRIPTION_TOPIC = "lk.transcription";
/** 同じ発話の途中経過をまとめる鍵。`ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID`。 */
const SEGMENT_ID_ATTRIBUTE = "lk.segment_id";
/** 先輩の「聞いている / 考えている / 喋っている」。`ATTRIBUTE_AGENT_STATE`。 */
const AGENT_STATE_ATTRIBUTE = "lk.agent.state";

/** 先輩が部屋に来るのを待つ上限。アプリの `senpaiJoinTimeout` と同じ。 */
const SENPAI_JOIN_TIMEOUT_MS = 25_000;

/**
 * 接続して、出来事をコールバックへ流す。
 *
 * `handlers` は `{ onBoardPayload, onTranscript, onAgentState, onAgentJoined,
 * onAgentMissing, onClosed, onLog }`。
 */
export async function connectRoom({ url, token, audioElement, handlers }) {
  const room = new Room({ adaptiveStream: false, dynacast: false });

  // 封筒1通 = 1ストリーム。読み出しを1本の鎖につないで到着順を保つ。
  let boardQueue = Promise.resolve();
  room.registerTextStreamHandler(BOARD_TOPIC, (reader) => {
    boardQueue = boardQueue.then(async () => {
      try {
        handlers.onBoardPayload(await reader.readAll());
      } catch (error) {
        handlers.onLog("board_stream_failed", { message: String(error) });
      }
    });
  });

  // 字幕は先輩の声と自分の声の両方が流れてくる。喋っている途中から届くので、
  // **同じ発話は同じ行に差し替える**。まとめる鍵は agent が付ける `lk.segment_id` で、
  // 無ければストリームの id に落とす(そこを取り違えると、途中経過が
  // 行として積み上がって「先輩が同じことを何度も言った」ように見える)。
  room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participant) => {
    const id =
      reader.info?.attributes?.[SEGMENT_ID_ATTRIBUTE] ?? reader.info?.id ?? crypto.randomUUID();
    const speaker = participant?.identity === room.localParticipant.identity ? "student" : "senpai";
    let text = "";
    try {
      for await (const chunk of reader) {
        text += chunk;
        handlers.onTranscript({ id, speaker, text, final: false });
      }
    } catch (error) {
      handlers.onLog("transcription_stream_failed", { message: String(error) });
    }
    handlers.onTranscript({ id, speaker, text, final: true });
  });

  let senpaiIdentity = null;
  let watchdog = null;

  const onSenpaiJoined = (participant) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    senpaiIdentity = participant.identity;
    handlers.onAgentJoined(participant.identity);
    syncAgentState(participant);
  };

  const syncAgentState = (participant) => {
    const state = participant.attributes?.[AGENT_STATE_ATTRIBUTE];
    if (state) handlers.onAgentState(state);
  };

  room
    .on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.kind === ParticipantKind.AGENT) onSenpaiJoined(participant);
    })
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === senpaiIdentity) handlers.onClosed("senpai_left");
    })
    .on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
      if (participant.identity === senpaiIdentity) syncAgentState(participant);
    })
    .on(RoomEvent.TrackSubscribed, (track) => {
      // 先輩の声。**再生先を用意しないと、板書だけが無音で進む。**
      if (track.kind === Track.Kind.Audio) track.attach(audioElement);
    })
    .on(RoomEvent.Disconnected, (reason) => {
      handlers.onClosed(`disconnected:${String(reason ?? "")}`);
    });

  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);

  const agent = [...room.remoteParticipants.values()].find(
    (participant) => participant.kind === ParticipantKind.AGENT,
  );
  if (agent) {
    onSenpaiJoined(agent);
  } else {
    watchdog = setTimeout(() => handlers.onAgentMissing(), SENPAI_JOIN_TIMEOUT_MS);
  }

  return {
    room,
    /** マイクの入り切り。教え返しの検証で「黙る」を作れるようにしてある。 */
    async setMicrophoneEnabled(enabled) {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
    async disconnect() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      await room.disconnect();
    },
  };
}
