import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../domain/session.dart';

/// 会話セッションの進行状態。
///
/// 会話そのものはエージェント側が回すので、アプリが持つのは
/// 「つながっているか」「後輩が喋っているか」「残り時間」だけ。
enum SessionPhase { connecting, listening, kohaiSpeaking, finished, failed }

@immutable
class SessionState {
  const SessionState({
    required this.phase,
    required this.remainingSeconds,
    this.lastKohaiText,
    this.error,
  });

  final SessionPhase phase;
  final int remainingSeconds;

  /// 直近の後輩の発話(字幕表示用)。声を聞き取れない場所でも進められるように出す。
  final String? lastKohaiText;
  final Object? error;

  SessionState copyWith({
    SessionPhase? phase,
    int? remainingSeconds,
    String? lastKohaiText,
    Object? error,
  }) {
    return SessionState(
      phase: phase ?? this.phase,
      remainingSeconds: remainingSeconds ?? this.remainingSeconds,
      lastKohaiText: lastKohaiText ?? this.lastKohaiText,
      error: error ?? this.error,
    );
  }
}

/// LiveKitルームへの接続を持つ。
///
/// WebRTCは書かない(livekit_clientに任せる)。ここでやるのは
/// 接続・マイク公開・残り時間のカウントダウン・切断だけ。
class SessionController extends AutoDisposeNotifier<SessionState> {
  Room? _room;
  Timer? _ticker;

  @override
  SessionState build() {
    ref.onDispose(_teardown);
    return const SessionState(phase: SessionPhase.connecting, remainingSeconds: 0);
  }

  Future<void> connect(SessionStart session) async {
    state = SessionState(
      phase: SessionPhase.connecting,
      remainingSeconds: session.limits.maxSeconds,
    );

    try {
      final Room room = Room();
      await room.connect(session.livekit.url, session.livekit.token);
      await room.localParticipant?.setMicrophoneEnabled(true);
      _room = room;

      state = state.copyWith(phase: SessionPhase.listening);
      _startTicker();
    } catch (error) {
      state = state.copyWith(phase: SessionPhase.failed, error: error);
    }
  }

  /// 上限時間はサーバが決める。クライアントは表示と自動終了だけを担当する。
  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (Timer timer) {
      final int remaining = state.remainingSeconds - 1;
      if (remaining <= 0) {
        timer.cancel();
        finish();
        return;
      }
      state = state.copyWith(remainingSeconds: remaining);
    });
  }

  void onKohaiSpeaking(String text) {
    state = state.copyWith(phase: SessionPhase.kohaiSpeaking, lastKohaiText: text);
  }

  void onUserTurn() {
    state = state.copyWith(phase: SessionPhase.listening);
  }

  Future<void> finish() async {
    await _teardown();
    state = state.copyWith(phase: SessionPhase.finished);
  }

  Future<void> _teardown() async {
    _ticker?.cancel();
    _ticker = null;
    await _room?.disconnect();
    await _room?.dispose();
    _room = null;
  }
}

final AutoDisposeNotifierProvider<SessionController, SessionState> sessionControllerProvider =
    AutoDisposeNotifierProvider<SessionController, SessionState>(SessionController.new);
