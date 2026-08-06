import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../karte/application/karte_controllers.dart';
import '../domain/session.dart';

part 'session_controller.g.dart';

/// 会話セッションの進行状態。
///
/// 会話そのものはエージェント側が回すので、アプリが持つのは
/// 「つながっているか」「後輩が喋っているか」「残り時間」だけ。
enum SessionPhase {
  /// ルームにつないで、後輩が入ってくるのを待っている。
  connecting,
  listening,
  kohaiSpeaking,

  /// 会話は終わり、カルテを待っている。生成に数秒かかる。
  summarizing,
  finished,
  failed,
}

/// 会話が始まらなかった理由。
///
/// **失敗を「聞いています」のまま見せない。** どちらの理由かで打つ手が違う
/// (電波を確かめる / 時間をおく)ので、画面の文言も分ける。
enum SessionFailure {
  /// ルームにつなげなかった。通信・トークン・マイクのどれか。
  connection,

  /// つながったが、後輩が入ってこなかった。エージェント側の問題。
  kohaiUnavailable,
}

@immutable
class SessionState {
  const SessionState({
    required this.phase,
    required this.remainingSeconds,
    this.lastKohaiText,
    this.failure,
    this.error,
    this.showPaywall = false,
    this.resultMissing = false,
  });

  final SessionPhase phase;
  final int remainingSeconds;

  /// 直近の後輩の発話(字幕表示用)。声を聞き取れない場所でも進められるように出す。
  final String? lastKohaiText;

  /// `phase == failed` のときだけ入る。
  final SessionFailure? failure;
  final Object? error;

  /// サーバが「ここで出す」と判断したときだけ true(初回カルテで穴が見えた直後)。
  final bool showPaywall;

  /// カルテを待ちきれなかった。祝福だけ見せて、カルテは後で取りに行く。
  final bool resultMissing;

  SessionState copyWith({
    SessionPhase? phase,
    int? remainingSeconds,
    String? lastKohaiText,
    SessionFailure? failure,
    Object? error,
    bool? showPaywall,
    bool? resultMissing,
  }) {
    return SessionState(
      phase: phase ?? this.phase,
      remainingSeconds: remainingSeconds ?? this.remainingSeconds,
      lastKohaiText: lastKohaiText ?? this.lastKohaiText,
      failure: failure ?? this.failure,
      error: error ?? this.error,
      showPaywall: showPaywall ?? this.showPaywall,
      resultMissing: resultMissing ?? this.resultMissing,
    );
  }
}

/// LiveKitルームへの接続を持つ。
///
/// WebRTCは書かない(livekit_clientに任せる)。ここでやるのは
/// 接続・マイク公開・**後輩の出入りと発話の受け取り**・残り時間・切断だけ。
/// 会話の寿命に合わせて破棄する(画面を離れたら接続も状態も残さない)。
@riverpod
class SessionController extends _$SessionController {
  Room? _room;
  EventsListener<RoomEvent>? _events;
  TranscriptionStreamReceiver? _transcripts;
  StreamSubscription<ReceivedMessage>? _transcriptSubscription;
  Timer? _ticker;
  Timer? _kohaiWatchdog;
  String? _sessionId;

  /// 後輩の状態(`lk.agent.state`)の読み取りはSDKに任せる。
  final Agent _kohai = Agent();
  String? _kohaiIdentity;
  bool _finishing = false;

  /// 後輩が部屋に来るのを待つ時間。
  ///
  /// エージェントのワーカーが動いていない・ディスパッチされていないときは、
  /// 部屋は開いたまま誰も来ない。**待ち続けさせない**(上限時間まで
  /// 「聞いています」を見せるのが、いちばん不親切な壊れ方)。
  static const Duration kohaiJoinTimeout = Duration(seconds: 25);

  @override
  SessionState build() {
    ref.onDispose(() {
      unawaited(_teardown());
    });
    return const SessionState(phase: SessionPhase.connecting, remainingSeconds: 0);
  }

  Future<void> connect(SessionStart session) async {
    _sessionId = session.sessionId;
    state = SessionState(
      phase: SessionPhase.connecting,
      remainingSeconds: session.limits.maxSeconds,
    );

    try {
      final Room room = Room();
      _room = room;
      final EventsListener<RoomEvent> events = room.createListener();
      _watch(events);
      _events = events;

      await room.connect(session.livekit.url, session.livekit.token);
      await room.localParticipant?.setMicrophoneEnabled(true);

      // 後輩の発話と、自分の声の認識結果は `lk.transcription` で流れてくる。
      // 字幕はここから来る(聞き取れない場所でも会話を追えるようにするため)。
      final TranscriptionStreamReceiver transcripts = TranscriptionStreamReceiver(room: room);
      _transcriptSubscription = transcripts.messages().listen(_onTranscript);
      _transcripts = transcripts;

      _startTicker();

      // 先にディスパッチされていれば、もう部屋にいる。
      if (room.agentParticipant != null) {
        _onKohaiJoined();
      } else {
        _kohaiWatchdog = Timer(kohaiJoinTimeout, _onKohaiNeverCame);
      }
    } catch (error) {
      await _teardown();
      state = state.copyWith(
        phase: SessionPhase.failed,
        failure: SessionFailure.connection,
        error: error,
      );
    }
  }

  /// つなぎ直す。**セッションは作り直さない**(同じトークンで入り直すので、
  /// 無料枠を二重に消費しない)。
  Future<void> retry(SessionStart session) async {
    await _teardown();
    _finishing = false;
    _kohaiIdentity = null;
    await connect(session);
  }

  /// 上限時間はサーバが決める。クライアントは表示と自動終了だけを担当する。
  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (Timer timer) {
      final int remaining = state.remainingSeconds - 1;
      if (remaining <= 0) {
        timer.cancel();
        unawaited(finish());
        return;
      }
      state = state.copyWith(remainingSeconds: remaining);
    });
  }

  /// ルームの出来事を状態に落とす。ここが無いと、後輩が喋っても
  /// 部屋を出ても画面は「聞いています」のまま止まる。
  void _watch(EventsListener<RoomEvent> events) {
    events
      ..on<ParticipantConnectedEvent>((ParticipantConnectedEvent event) {
        if (event.participant.kind == ParticipantKind.AGENT) _onKohaiJoined();
      })
      ..on<ParticipantDisconnectedEvent>((ParticipantDisconnectedEvent event) {
        if (event.participant.identity == _kohaiIdentity) _onKohaiLeft();
      })
      // 後輩の「聞いている / 考えている / 喋っている」は属性で来る
      ..on<ParticipantAttributesChanged>((_) => _syncKohaiState())
      ..on<RoomDisconnectedEvent>((_) => _onRoomClosed());
  }

  void _onKohaiJoined() {
    _kohaiWatchdog?.cancel();
    _kohaiWatchdog = null;
    _kohaiIdentity = _room?.agentParticipant?.identity;
    if (state.phase == SessionPhase.connecting) {
      state = state.copyWith(phase: SessionPhase.listening);
    }
    _syncKohaiState();
  }

  /// 後輩が退室した = 会話は終わり。
  ///
  /// 締めの言葉で終わっても上限時間で終わっても、エージェントは部屋を出てから
  /// カルテを作りに行く。**ここで結果を取りに行かないと、会話が自然に終わった
  /// あとも画面は上限時間まで「聞いています」のまま残る。**
  void _onKohaiLeft() {
    if (_kohaiIdentity == null) return;
    unawaited(finish());
  }

  void _onRoomClosed() {
    if (_finishing || state.phase == SessionPhase.finished || state.phase == SessionPhase.failed) {
      return;
    }
    if (_kohaiIdentity == null) {
      // 後輩が来ないまま部屋が閉じた。会話は成立していないのでカルテも無い。
      unawaited(_teardown());
      state = state.copyWith(
        phase: SessionPhase.failed,
        failure: SessionFailure.connection,
      );
      return;
    }
    unawaited(finish());
  }

  Future<void> _onKohaiNeverCame() async {
    if (_kohaiIdentity != null) return;
    await _teardown();
    state = state.copyWith(
      phase: SessionPhase.failed,
      failure: SessionFailure.kohaiUnavailable,
    );
  }

  void _syncKohaiState() {
    final RemoteParticipant? kohai = _room?.agentParticipant;
    if (kohai == null) return;
    _kohai.connected(kohai);
    switch (_kohai.agentState) {
      case AgentState.speaking:
        state = state.copyWith(phase: SessionPhase.kohaiSpeaking);
      case AgentState.listening:
      case AgentState.thinking:
        if (state.phase == SessionPhase.connecting ||
            state.phase == SessionPhase.kohaiSpeaking) {
          state = state.copyWith(phase: SessionPhase.listening);
        }
      case AgentState.idle:
      case AgentState.initializing:
      case null:
        break;
    }
  }

  void _onTranscript(ReceivedMessage message) {
    switch (message.content) {
      case AgentTranscript(:final String text):
        if (text.trim().isEmpty) return;
        onKohaiSpeaking(text);
      case UserTranscript():
        // 自分の声が届いている印。字幕は後輩の発話だけ残す。
        onUserTurn();
      default:
        break;
    }
  }

  void onKohaiSpeaking(String text) {
    state = state.copyWith(phase: SessionPhase.kohaiSpeaking, lastKohaiText: text);
  }

  void onUserTurn() {
    if (state.phase == SessionPhase.summarizing ||
        state.phase == SessionPhase.finished ||
        state.phase == SessionPhase.failed) {
      return;
    }
    state = state.copyWith(phase: SessionPhase.listening);
  }

  /// 「うまく言えない」。
  ///
  /// パスは恥ではなく穴の記録なので、**後輩にも伝える**。伝えないと、
  /// こちらの画面だけが切り替わって、後輩は同じ質問を待ち続ける。
  Future<void> pass(String message) async {
    onUserTurn();
    try {
      await _room?.localParticipant?.sendText(
        message,
        options: SendTextOptions(topic: 'lk.chat'),
      );
    } catch (error) {
      // 伝わらなくても会話は続けられる。ここで画面を止めない。
      debugPrint('パスを送れませんでした: $error');
    }
  }

  /// 会話を終える。
  ///
  /// カルテはエージェントが作ってサーバへ送るので、アプリは
  /// `/v1/sessions/{id}/result` を見に行って結果を受け取る。
  /// ここで受け取らないと、祝福もカルテも空のまま表示されてしまう。
  Future<void> finish() async {
    if (_finishing) return;
    _finishing = true;

    final bool talked = _kohaiIdentity != null;
    await _teardown();

    final String? sessionId = _sessionId;
    if (!talked) {
      // 後輩が来ていないので、カルテは作られない。待たせずに理由を出す。
      state = state.copyWith(
        phase: SessionPhase.failed,
        failure: SessionFailure.kohaiUnavailable,
      );
      return;
    }

    state = state.copyWith(phase: SessionPhase.summarizing);

    if (sessionId == null) {
      _publish(const SessionOutcome(resultMissing: true));
      state = state.copyWith(phase: SessionPhase.finished, resultMissing: true);
      return;
    }

    try {
      final SessionResult? result =
          await ref.read(apiClientProvider).awaitSessionResult(sessionId);
      if (result == null) {
        // 生成が間に合わなかった。祝福は見せて、カルテは後で取りに行く。
        _publish(SessionOutcome(resultMissing: true, sessionId: sessionId));
        state = state.copyWith(phase: SessionPhase.finished, resultMissing: true);
        return;
      }

      ref.read(latestKarteControllerProvider.notifier).set(result.karte);
      ref.read(progressControllerProvider.notifier).applyFromSession(result.progress);
      _publish(SessionOutcome(showPaywall: result.showPaywall, sessionId: sessionId));
      state = state.copyWith(
        phase: SessionPhase.finished,
        showPaywall: result.showPaywall,
      );
    } catch (error) {
      _publish(SessionOutcome(resultMissing: true, sessionId: sessionId));
      state = state.copyWith(
        phase: SessionPhase.finished,
        resultMissing: true,
        error: error,
      );
    }
  }

  /// 会話画面(AutoDispose)の寿命を超えて持ち回る結果を置く。
  void _publish(SessionOutcome outcome) {
    ref.read(sessionOutcomeControllerProvider.notifier).set(outcome);
  }

  Future<void> _teardown() async {
    _ticker?.cancel();
    _ticker = null;
    _kohaiWatchdog?.cancel();
    _kohaiWatchdog = null;
    // 先に購読を切る。切断そのものがイベントになって戻ってくるのを避ける。
    await _transcriptSubscription?.cancel();
    _transcriptSubscription = null;
    await _transcripts?.dispose();
    _transcripts = null;
    await _events?.dispose();
    _events = null;
    await _room?.disconnect();
    await _room?.dispose();
    _room = null;
  }
}
