import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../domain/study_plan.dart';

part 'plan_controller.g.dart';

enum PlanPhase {
  loading,
  ready,
  connecting,
  listening,
  senpaiSpeaking,
  saving,
  failed,
}

enum PlanFailure { load, connection, senpaiUnavailable }

@immutable
class PlanState {
  const PlanState({
    required this.phase,
    this.plan,
    this.lastSenpaiText,
    this.failure,
    this.error,
    this.premiumRequired = false,
    this.resultPending = false,
  });

  final PlanPhase phase;
  final StudyPlan? plan;
  final String? lastSenpaiText;
  final PlanFailure? failure;
  final Object? error;

  /// APIだけがPremium境界の正。画面はtrueになった瞬間にペイウォールを重ねる。
  final bool premiumRequired;

  /// agentは退出してから保存するので、短い待ち時間では計画がまだ読めないことがある。
  final bool resultPending;

  PlanState copyWith({
    PlanPhase? phase,
    StudyPlan? plan,
    bool replacePlan = false,
    String? lastSenpaiText,
    PlanFailure? failure,
    Object? error,
    bool clearError = false,
    bool? premiumRequired,
    bool? resultPending,
  }) {
    return PlanState(
      phase: phase ?? this.phase,
      plan: replacePlan ? plan : this.plan,
      lastSenpaiText: lastSenpaiText ?? this.lastSenpaiText,
      failure: failure,
      error: clearError ? null : (error ?? this.error),
      premiumRequired: premiumRequired ?? this.premiumRequired,
      resultPending: resultPending ?? this.resultPending,
    );
  }
}

/// 計画モードのLiveKit接続。
///
/// 授業コントローラを流用しない。あちらは板書・カルテ・日次授業枠を寿命に持ち、
/// 計画はどれも持たない。WebRTCの手順だけを同じにし、退出後は `/v1/me/plan` の
/// 変更を待つことで「計画が保存された」を画面へ反映する。
@riverpod
class PlanController extends _$PlanController {
  Room? _room;
  EventsListener<RoomEvent>? _events;
  TranscriptionStreamReceiver? _transcripts;
  StreamSubscription<ReceivedMessage>? _transcriptSubscription;
  Timer? _senpaiWatchdog;
  final Agent _senpai = Agent();
  String? _senpaiIdentity;
  bool _finishing = false;
  PlanSessionStart? _activeSession;
  StudyPlan? _baselinePlan;

  static const Duration _senpaiJoinTimeout = Duration(seconds: 25);
  static const Duration _disconnectTimeout = Duration(seconds: 3);
  static const Duration _planPollInterval = Duration(seconds: 1);
  static const int _planPollAttempts = 12;

  @override
  PlanState build() {
    ref.onDispose(() => unawaited(_teardown()));
    return const PlanState(phase: PlanPhase.loading);
  }

  Future<void> load() async {
    state = state.copyWith(
      phase: PlanPhase.loading,
      clearError: true,
      resultPending: false,
    );
    try {
      final StudyPlan? plan = await ref.read(apiClientProvider).fetchPlan();
      if (!ref.mounted) return;
      state = PlanState(phase: PlanPhase.ready, plan: plan);
    } catch (error) {
      if (!ref.mounted) return;
      state = PlanState(
        phase: PlanPhase.failed,
        failure: PlanFailure.load,
        error: error,
      );
    }
  }

  /// フォームは作らず、ロケールだけを渡してすぐマイクへ進む。
  Future<void> start(String locale) async {
    await _teardown();
    _finishing = false;
    _senpaiIdentity = null;
    state = state.copyWith(
      phase: PlanPhase.connecting,
      clearError: true,
      premiumRequired: false,
      resultPending: false,
    );

    try {
      final PlanSessionStart session = await ref
          .read(apiClientProvider)
          .createPlanSession(locale: locale);
      if (!ref.mounted) return;
      _activeSession = session;
      _baselinePlan = session.currentPlan;
      state = state.copyWith(plan: session.currentPlan, replacePlan: true);
      await _connect(session);
    } catch (error) {
      if (!ref.mounted) return;
      if (isPremiumRequiredApiError(error)) {
        state = state.copyWith(
          phase: PlanPhase.ready,
          premiumRequired: true,
          clearError: true,
        );
        return;
      }
      state = state.copyWith(
        phase: PlanPhase.failed,
        failure: PlanFailure.connection,
        error: error,
      );
    }
  }

  Future<void> _connect(PlanSessionStart session) async {
    try {
      final Room room = Room();
      _room = room;
      final EventsListener<RoomEvent> events = room.createListener();
      _watch(events);
      _events = events;

      await room.connect(session.livekit.url, session.livekit.token);
      await room.localParticipant?.setMicrophoneEnabled(true);

      final TranscriptionStreamReceiver transcripts =
          TranscriptionStreamReceiver(room: room);
      _transcriptSubscription = transcripts.messages().listen(_onTranscript);
      _transcripts = transcripts;

      if (room.agentParticipant != null) {
        _onSenpaiJoined();
      } else {
        _senpaiWatchdog = Timer(_senpaiJoinTimeout, _onSenpaiNeverCame);
      }
    } catch (error) {
      await _teardown();
      if (!ref.mounted) return;
      state = state.copyWith(
        phase: PlanPhase.failed,
        failure: PlanFailure.connection,
        error: error,
      );
    }
  }

  void _watch(EventsListener<RoomEvent> events) {
    events
      ..on<ParticipantConnectedEvent>((ParticipantConnectedEvent event) {
        if (event.participant.kind == ParticipantKind.AGENT) _onSenpaiJoined();
      })
      ..on<ParticipantDisconnectedEvent>((ParticipantDisconnectedEvent event) {
        if (event.participant.identity == _senpaiIdentity) unawaited(finish());
      })
      ..on<ParticipantAttributesChanged>((_) => _syncSenpaiState())
      ..on<RoomDisconnectedEvent>((_) {
        if (_finishing) return;
        if (_senpaiIdentity == null) {
          unawaited(_failConnection());
        } else {
          unawaited(finish());
        }
      });
  }

  void _onSenpaiJoined() {
    _senpaiWatchdog?.cancel();
    _senpaiWatchdog = null;
    _senpaiIdentity = _room?.agentParticipant?.identity;
    if (state.phase == PlanPhase.connecting) {
      state = state.copyWith(phase: PlanPhase.listening);
    }
    _syncSenpaiState();
  }

  void _syncSenpaiState() {
    final RemoteParticipant? participant = _room?.agentParticipant;
    if (participant == null) return;
    _senpai.connected(participant);
    switch (_senpai.agentState) {
      case AgentState.speaking:
        state = state.copyWith(phase: PlanPhase.senpaiSpeaking);
      case AgentState.listening:
      case AgentState.thinking:
        if (state.phase == PlanPhase.connecting ||
            state.phase == PlanPhase.senpaiSpeaking) {
          state = state.copyWith(phase: PlanPhase.listening);
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
        state = state.copyWith(
          phase: PlanPhase.senpaiSpeaking,
          lastSenpaiText: text,
        );
      case UserTranscript():
        state = state.copyWith(phase: PlanPhase.listening);
      default:
        break;
    }
  }

  Future<void> _onSenpaiNeverCame() async {
    if (_senpaiIdentity != null) return;
    await _teardown();
    if (!ref.mounted) return;
    state = state.copyWith(
      phase: PlanPhase.failed,
      failure: PlanFailure.senpaiUnavailable,
    );
  }

  Future<void> _failConnection() async {
    await _teardown();
    if (!ref.mounted) return;
    state = state.copyWith(
      phase: PlanPhase.failed,
      failure: PlanFailure.connection,
    );
  }

  /// 同じトークンでつなぎ直す。新しい有料セッションを勝手に作らない。
  Future<void> retryConnection() async {
    final PlanSessionStart? session = _activeSession;
    if (session == null) {
      await load();
      return;
    }
    await _teardown();
    _finishing = false;
    _senpaiIdentity = null;
    state = state.copyWith(phase: PlanPhase.connecting, clearError: true);
    await _connect(session);
  }

  Future<void> finish() async {
    if (_finishing) return;
    _finishing = true;
    _senpaiWatchdog?.cancel();
    _senpaiWatchdog = null;

    final bool talked = _senpaiIdentity != null;
    state = state.copyWith(
      phase: talked ? PlanPhase.saving : PlanPhase.failed,
      failure: talked ? null : PlanFailure.senpaiUnavailable,
    );
    await _teardown();
    if (!talked || !ref.mounted) return;

    StudyPlan? latest = _baselinePlan;
    try {
      for (int attempt = 0; attempt < _planPollAttempts; attempt++) {
        latest = await ref.read(apiClientProvider).fetchPlan();
        if (latest != _baselinePlan) break;
        if (attempt < _planPollAttempts - 1) {
          await Future<void>.delayed(_planPollInterval);
        }
      }
      if (!ref.mounted) return;
      final bool changed = latest != _baselinePlan;
      state = PlanState(
        phase: PlanPhase.ready,
        plan: latest,
        resultPending: !changed,
      );
    } catch (error) {
      if (!ref.mounted) return;
      // 保存結果が取れなくても、前の計画を消さない。通信が戻れば再読み込みできる。
      state = PlanState(
        phase: PlanPhase.ready,
        plan: latest,
        error: error,
        resultPending: true,
      );
    }
  }

  void acknowledgePremiumRequired() {
    state = state.copyWith(premiumRequired: false);
  }

  Future<void> _teardown() async {
    _senpaiWatchdog?.cancel();
    _senpaiWatchdog = null;
    final Room? room = _room;
    _room = null;

    await _quietly(() => _transcriptSubscription?.cancel());
    _transcriptSubscription = null;
    await _quietly(() => _transcripts?.dispose());
    _transcripts = null;
    await _quietly(() => _events?.dispose());
    _events = null;
    await _quietly(() => room?.disconnect().timeout(_disconnectTimeout));
    await _quietly(() => room?.dispose());
  }

  Future<void> _quietly(FutureOr<void> Function() step) async {
    try {
      await step();
    } catch (error) {
      debugPrint('計画モードの片付けに失敗しました(片付けは続けます): $error');
    }
  }
}
