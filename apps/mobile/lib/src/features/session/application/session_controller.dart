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
  connecting,
  listening,
  kohaiSpeaking,

  /// 会話は終わり、カルテを待っている。生成に数秒かかる。
  summarizing,
  finished,
  failed,
}

@immutable
class SessionState {
  const SessionState({
    required this.phase,
    required this.remainingSeconds,
    this.lastKohaiText,
    this.error,
    this.showPaywall = false,
    this.resultMissing = false,
  });

  final SessionPhase phase;
  final int remainingSeconds;

  /// 直近の後輩の発話(字幕表示用)。声を聞き取れない場所でも進められるように出す。
  final String? lastKohaiText;
  final Object? error;

  /// サーバが「ここで出す」と判断したときだけ true(初回カルテで穴が見えた直後)。
  final bool showPaywall;

  /// カルテを待ちきれなかった。祝福だけ見せて、カルテは後で取りに行く。
  final bool resultMissing;

  SessionState copyWith({
    SessionPhase? phase,
    int? remainingSeconds,
    String? lastKohaiText,
    Object? error,
    bool? showPaywall,
    bool? resultMissing,
  }) {
    return SessionState(
      phase: phase ?? this.phase,
      remainingSeconds: remainingSeconds ?? this.remainingSeconds,
      lastKohaiText: lastKohaiText ?? this.lastKohaiText,
      error: error ?? this.error,
      showPaywall: showPaywall ?? this.showPaywall,
      resultMissing: resultMissing ?? this.resultMissing,
    );
  }
}

/// LiveKitルームへの接続を持つ。
///
/// WebRTCは書かない(livekit_clientに任せる)。ここでやるのは
/// 接続・マイク公開・残り時間のカウントダウン・切断だけ。
/// 会話の寿命に合わせて破棄する(画面を離れたら接続も状態も残さない)。
@riverpod
class SessionController extends _$SessionController {
  Room? _room;
  Timer? _ticker;
  String? _sessionId;

  @override
  SessionState build() {
    ref.onDispose(_teardown);
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

  /// 会話を終える。
  ///
  /// カルテはエージェントが作ってサーバへ送るので、アプリは
  /// `/v1/sessions/{id}/result` を見に行って結果を受け取る。
  /// ここで受け取らないと、祝福もカルテも空のまま表示されてしまう。
  Future<void> finish() async {
    await _teardown();
    state = state.copyWith(phase: SessionPhase.summarizing);

    final String? sessionId = _sessionId;
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
        _publish(const SessionOutcome(resultMissing: true));
        state = state.copyWith(phase: SessionPhase.finished, resultMissing: true);
        return;
      }

      ref.read(latestKarteControllerProvider.notifier).set(result.karte);
      ref.read(progressControllerProvider.notifier).applyFromSession(result.progress);
      _publish(SessionOutcome(showPaywall: result.showPaywall));
      state = state.copyWith(
        phase: SessionPhase.finished,
        showPaywall: result.showPaywall,
      );
    } catch (error) {
      _publish(const SessionOutcome(resultMissing: true));
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
    await _room?.disconnect();
    await _room?.dispose();
    _room = null;
  }
}

