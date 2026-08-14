import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../../audio/prerendered_audio.dart';
import '../../../telemetry/telemetry.dart';
import '../../karte/application/karte_controllers.dart';
import '../../karte/application/last_board_controller.dart';
import '../domain/board.dart';
import '../domain/session.dart';
import 'board_inbox.dart';
import 'lesson_opening_audio.dart';

part 'session_controller.g.dart';

/// Progress state of a conversation session.
///
/// The agent drives the conversation itself, so the app holds only whether it is
/// connected, whether senpai is speaking, and the time left.
///
/// Lesson mode changes what "who is speaking" means. While a board is up,
/// senpai's speech is an explanation rather than a question, and ours is
/// teaching back rather than explaining. The signal (`AgentState`) is the same,
/// but the screen differs, so the phases are separate. Existing review
/// conversations receive no board, so that path is unchanged.
enum SessionPhase {
  /// Connected to the room, waiting for senpai to join.
  connecting,
  listening,
  senpaiSpeaking,

  /// Senpai is teaching with the board (lesson mode).
  senpaiTeaching,

  /// "Now explain that back to me": our turn, with the board still up.
  explainBack,

  /// The conversation is over and the karte is pending; generation takes seconds.
  summarizing,
  finished,
  failed,
}

/// Why the conversation never started.
///
/// A failure must never keep showing "listening". The remedies differ (check the
/// signal vs wait a while), so the wording differs too.
enum SessionFailure {
  /// Could not connect to the room: network, token or mic.
  connection,

  /// Connected, but senpai never joined. An agent-side problem.
  senpaiUnavailable,
}

@immutable
class SessionState {
  const SessionState({
    required this.phase,
    required this.remainingSeconds,
    this.lastSenpaiText,
    this.board = BoardSnapshot.empty,
    this.failure,
    this.error,
    this.showPaywall = false,
    this.resultMissing = false,
  });

  final SessionPhase phase;
  final int remainingSeconds;

  /// Senpai's latest utterance, for captions, so it works where audio cannot be
  /// heard.
  final String? lastSenpaiText;

  /// What is currently on the board; it lives for one problem. Conversations
  /// that receive no board (existing review) leave it empty.
  final BoardSnapshot board;

  /// Set only when `phase == failed`.
  final SessionFailure? failure;
  final Object? error;

  /// True only when the server decides to show it — just after a gap appears in
  /// the first karte.
  final bool showPaywall;

  /// We could not wait for the karte; show the celebration and fetch it later.
  final bool resultMissing;

  SessionState copyWith({
    SessionPhase? phase,
    int? remainingSeconds,
    String? lastSenpaiText,
    BoardSnapshot? board,
    SessionFailure? failure,
    Object? error,
    bool? showPaywall,
    bool? resultMissing,
  }) {
    return SessionState(
      phase: phase ?? this.phase,
      remainingSeconds: remainingSeconds ?? this.remainingSeconds,
      lastSenpaiText: lastSenpaiText ?? this.lastSenpaiText,
      board: board ?? this.board,
      failure: failure ?? this.failure,
      error: error ?? this.error,
      showPaywall: showPaywall ?? this.showPaywall,
      resultMissing: resultMissing ?? this.resultMissing,
    );
  }
}

/// Holds the connection to the LiveKit room.
///
/// No WebRTC here (livekit_client handles that). This does only connecting,
/// publishing the mic, receiving senpai joining, leaving and speaking, the time
/// left, and disconnecting. It is disposed with the conversation, so leaving the
/// screen leaves neither connection nor state behind.
@riverpod
class SessionController extends _$SessionController {
  Room? _room;
  EventsListener<RoomEvent>? _events;
  TranscriptionStreamReceiver? _transcripts;
  StreamSubscription<ReceivedMessage>? _transcriptSubscription;
  Timer? _ticker;
  Timer? _senpaiWatchdog;
  String? _sessionId;
  String? _sessionKind;

  /// Board receiver, rebuilt on each connection — boards never span sessions.
  BoardInbox? _boardInbox;

  /// Lifetime of the local audio filling the gap before the first board step.
  ///
  /// Sending the same fixed line through the agent's TTS would incur metered
  /// cost every time. We play a mobile asset instead and stop it as soon as the
  /// board or the real senpai arrives.
  LessonOpeningAudio? _lessonOpeningAudio;

  /// Chain that serializes envelope handling in arrival order.
  ///
  /// Handlers fire in arrival order, but `readAll()` does not necessarily
  /// complete in that order (a later envelope with fewer chunks can finish
  /// first). Reordering makes the receiver's `seq` check treat it as a gap, so
  /// the board truncates even though everything arrived. Chaining the reads
  /// themselves keeps processing in arrival order.
  ///
  /// Removing this produces a failure that is hard to reproduce: whether
  /// overtaking happens depends on chunk counts (the length of `tex` or
  /// `speech`) and the connection, so the same problem breaks only sometimes.
  /// And the symptom is "the board was truncated" — delivery is fine and the gap
  /// detector is the thing raising a false alarm.
  Future<void> _boardQueue = Future<void>.value();

  /// Reading senpai's state (`lk.agent.state`) is left to the SDK.
  final Agent _senpai = Agent();
  String? _senpaiIdentity;
  bool _finishing = false;

  /// How long to wait for senpai to join.
  ///
  /// If the agent worker is down or never dispatched, the room stays open and
  /// nobody arrives. Do not let people wait it out: showing "listening" until the
  /// time limit is the unkindest way to fail.
  static const Duration senpaiJoinTimeout = Duration(seconds: 25);

  /// Cap on waiting for disconnection to complete.
  ///
  /// The SDK's `Room.disconnect()` waits 10 seconds for the completion event
  /// before throwing. After a conversation, those 10 seconds are just a frozen
  /// screen waiting on the karte. We wait this long and leave the rest to
  /// `dispose()`.
  static const Duration _disconnectTimeout = Duration(seconds: 3);

  /// Cap on waiting for the karte on the conversation screen.
  ///
  /// The agent writes the karte with an LLM, taking seconds to tens of seconds
  /// after the conversation ends. We do not wait all of it here: waiting it out
  /// leaves up to a minute of "thinking" where taps do nothing. Past this we move
  /// on to the celebration, which fetches the karte itself
  /// ([SessionOutcomeController.retrieveKarte]).
  static const Duration _karteGrace = Duration(seconds: 8);
  static const Duration _kartePollInterval = Duration(seconds: 1);

  /// Cap on reading one envelope to completion.
  ///
  /// An envelope is one step (a few hundred bytes) delivered over a reliable
  /// path. If it is not complete after five seconds it is not slow, it is not
  /// coming. Without a cap, one stream that never closes stalls [_boardQueue] and
  /// every later board line with it, while the screen waits with a "not yet"
  /// face. An abandoned envelope surfaces as the next `seq` mismatch — which is
  /// what `seq` is for.
  static const Duration _boardStreamTimeout = Duration(seconds: 5);

  @override
  SessionState build() {
    ref.onDispose(() {
      unawaited(_teardown());
    });
    return const SessionState(phase: SessionPhase.connecting, remainingSeconds: 0);
  }

  Future<void> connect(SessionStart session, {required String locale}) async {
    _sessionId = session.sessionId;
    _sessionKind = session.kind;

    final LessonOpeningAudio openingAudio = LessonOpeningAudio(
      ref.read(prerenderedAudioProvider),
    );
    _lessonOpeningAudio = openingAudio;
    // Arm before connecting: connection events can arrive ahead of the
    // `Room.connect()` future, and if senpai speaks in one we need to record
    // "do not play".
    //
    // Review is included. A review re-teaches the previous gap with a board
    // (`startsWithBoardLesson` on the agent), so it has the same silence before
    // the first step as a new lesson. The agent no longer speaks the opening
    // line through TTS (no metered cost for a fixed line), so without this the
    // start of a review would be completely silent. On the degraded path with no
    // board, senpai starts speaking immediately and `senpaiStartedSpeaking()`
    // stops the cue, so they never overlap.
    openingAudio.arm(
      lessonMode: session.kind == 'new' || session.kind == 'review',
      languageCode: locale,
    );

    // The server settled whether another lesson can start today when the session
    // was created. Carry that boolean over so returning home does not show a
    // stale allowance.
    ref
        .read(progressControllerProvider.notifier)
        .applyLessonAllowance(session.limits.lessonAllowedToday);

    // Do not carry the previous conversation's result over: if this karte fails
    // to generate, both celebration and karte would show the previous one as
    // today's.
    ref.read(sessionOutcomeControllerProvider.notifier).clear();
    ref.read(latestKarteControllerProvider.notifier).clear();

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

      // Register before connecting: senpai starts sending board steps on join,
      // so registering after the connection completes drops the first few.
      _boardInbox = BoardInbox(sessionId: session.sessionId);
      _boardQueue = Future<void>.value();
      room.registerTextStreamHandler(boardChannelTopic, _onBoardStream);

      await room.connect(session.livekit.url, session.livekit.token);

      // After connecting, it runs alongside the agent generating the board.
      // Starting before publishing the mic lets LiveKit reliably reclaim the
      // conversation session after the ambient one (which respects the iOS mute
      // switch) is prepared; reversed, it could overwrite the recording setup.
      await openingAudio.start();
      await room.localParticipant?.setMicrophoneEnabled(true);

      // Senpai's speech and our own recognition results arrive on
      // `lk.transcription`; the captions come from here, so the conversation can
      // be followed where audio cannot be heard.
      final TranscriptionStreamReceiver transcripts = TranscriptionStreamReceiver(room: room);
      _transcriptSubscription = transcripts.messages().listen(_onTranscript);
      _transcripts = transcripts;

      _startTicker();

      // If dispatched earlier, senpai is already in the room.
      if (room.agentParticipant != null) {
        _onSenpaiJoined();
      } else {
        _senpaiWatchdog = Timer(senpaiJoinTimeout, _onSenpaiNeverCame);
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

  /// Reconnects. The session is not recreated — rejoining with the same token
  /// never double-spends the free allowance.
  Future<void> retry(SessionStart session, {required String locale}) async {
    await _teardown();
    _finishing = false;
    _senpaiIdentity = null;
    await connect(session, locale: locale);
  }

  /// The server sets the time limit; the client only displays it and auto-ends.
  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (Timer timer) {
      final int remaining = state.remainingSeconds - 1;
      // Never skip 0. Cutting off early freezes a timed-out conversation at
      // "0:01 left", a still screen with a second apparently remaining.
      state = state.copyWith(remainingSeconds: remaining < 0 ? 0 : remaining);
      if (remaining <= 0) {
        timer.cancel();
        unawaited(finish());
      }
    });
  }

  /// Maps room events into state. Without it, the screen stays on "listening"
  /// whether senpai speaks or leaves.
  void _watch(EventsListener<RoomEvent> events) {
    events
      ..on<ParticipantConnectedEvent>((ParticipantConnectedEvent event) {
        if (event.participant.kind == ParticipantKind.AGENT) _onSenpaiJoined();
      })
      ..on<ParticipantDisconnectedEvent>((ParticipantDisconnectedEvent event) {
        if (event.participant.identity == _senpaiIdentity) _onSenpaiLeft();
      })
      // Senpai's listening / thinking / speaking arrives as attributes.
      ..on<ParticipantAttributesChanged>((_) => _syncSenpaiState())
      ..on<RoomDisconnectedEvent>((_) => _onRoomClosed());
  }

  void _onSenpaiJoined() {
    _senpaiWatchdog?.cancel();
    _senpaiWatchdog = null;
    _senpaiIdentity = _room?.agentParticipant?.identity;
    if (state.phase == SessionPhase.connecting) {
      state = state.copyWith(phase: _listeningPhase);
    }
    _syncSenpaiState();
  }

  /// Senpai left, so the conversation is over.
  ///
  /// Whether it ended with a closing line or on the time limit, the agent leaves
  /// the room and then writes the karte. Without fetching the result here, a
  /// naturally ended conversation would sit on "listening" until the time limit.
  void _onSenpaiLeft() {
    if (_senpaiIdentity == null) return;
    unawaited(finish());
  }

  void _onRoomClosed() {
    if (_finishing || state.phase == SessionPhase.finished || state.phase == SessionPhase.failed) {
      return;
    }
    if (_senpaiIdentity == null) {
      // The room closed without senpai. No conversation happened, so no karte.
      unawaited(_teardown());
      state = state.copyWith(
        phase: SessionPhase.failed,
        failure: SessionFailure.connection,
      );
      return;
    }
    unawaited(finish());
  }

  Future<void> _onSenpaiNeverCame() async {
    if (_senpaiIdentity != null) return;
    await _teardown();
    state = state.copyWith(
      phase: SessionPhase.failed,
      failure: SessionFailure.senpaiUnavailable,
    );
  }

  void _syncSenpaiState() {
    final RemoteParticipant? senpai = _room?.agentParticipant;
    if (senpai == null) return;
    _senpai.connected(senpai);
    switch (_senpai.agentState) {
      case AgentState.speaking:
        // AgentState arrives before the captions; do not let local audio overlap
        // the start of the real voice.
        unawaited(_lessonOpeningAudio?.senpaiStartedSpeaking() ?? Future<void>.value());
        state = state.copyWith(phase: _speakingPhase);
      case AgentState.listening:
      case AgentState.thinking:
        // Once speaking ends, hand the turn back. In lesson mode that is teaching
        // back: this transition keeps the board and shows "explain it" below.
        if (state.phase == SessionPhase.connecting ||
            state.phase == SessionPhase.senpaiSpeaking ||
            state.phase == SessionPhase.senpaiTeaching) {
          state = state.copyWith(phase: _listeningPhase);
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
        onSenpaiSpeaking(text);
      case UserTranscript():
        // A sign our voice is getting through; captions keep senpai's speech only.
        onUserTurn();
      default:
        break;
    }
  }

  /// One board envelope arrived (Text Streams, topic `boardChannelTopic`).
  ///
  /// One envelope is one stream, so it is complete when `readAll()` returns and
  /// there is no partial JSON to reassemble. Reads are queued on [_boardQueue] to
  /// stay in arrival order (see that field).
  void _onBoardStream(TextStreamReader reader, String participantIdentity) {
    _boardQueue = _boardQueue.then((_) => _readBoardEnvelope(reader));
  }

  Future<void> _readBoardEnvelope(TextStreamReader reader) async {
    final BoardInbox? inbox = _boardInbox;
    if (inbox == null) return;

    final String payload;
    try {
      payload = await reader.readAll().timeout(_boardStreamTimeout);
    } catch (error) {
      // Give up on an envelope we could not read. Not swallowed: the next
      // envelope's `seq` will mismatch and the board shows as truncated.
      debugPrint('板書の封筒を読めませんでした(この1通は諦めます): $error');
      return;
    }

    // Torn down or reconnected mid-read. This envelope is not from the same
    // room, so keep it out of the new board — `retry()` rejoins with the same
    // session_id, so the envelope's destination check cannot catch it.
    if (!identical(_boardInbox, inbox)) return;

    if (!inbox.acceptPayload(payload)) return;
    // The screen was left mid-read; there is nowhere to write back to.
    if (!ref.mounted) return;
    _applyBoard(inbox.snapshot);
  }

  /// Reflects a board change on screen.
  ///
  /// The phase moves too: a board step arriving means senpai is writing, so if
  /// lesson mode has not started it starts here (unless the conversation is
  /// already closing).
  ///
  /// ## Contract for reading the board outside the lesson (the karte's board)
  ///
  /// This screen is AutoDispose, so [SessionState.board] dies the moment it is
  /// left. What must outlive the lesson is written to
  /// `lastBoardControllerProvider`
  /// (`features/karte/application/last_board_controller.dart`). This is the only
  /// writer. The promise to readers watching [LastBoardController]:
  ///
  ///   - the type is `List<BoardStep>`; with no board it is an empty list, never
  ///     null
  ///   - it holds everything currently on the board — a wholesale replacement,
  ///     not an append
  ///   - `board_open` (moving to another problem) replaces it entirely, and that
  ///     is the whole lifetime; `board_close` does not clear it, since one board
  ///     lives for one problem
  ///   - voice-only steps (`step.board == null`) are included in the list;
  ///     rendering drops them (as [BoardView] does)
  ///   - truncated boards are passed on too (lines up to the detected gap are
  ///     kept), with `truncated` carrying [BoardSnapshot.hasGap] so they can be
  ///     told apart from healthy ones
  void _applyBoard(BoardSnapshot board) {
    // `board_open` is only a heading, so it does not stop the cue. The cue's job
    // is to fill the silence until the first BoardStep; cutting it at the heading
    // would leave that gap.
    if (board.steps.isNotEmpty) {
      unawaited(_lessonOpeningAudio?.firstBoardStepArrived() ?? Future<void>.value());
    }
    state = state.copyWith(
      board: board,
      phase: _isTalking(state.phase) ? SessionPhase.senpaiTeaching : state.phase,
    );

    // Written on every change, not only on `board_close`: the close arrives only
    // when a problem finishes, so a board from a conversation ended early would
    // never be stored. Without `truncated`, a truncated board is kept in the
    // karte as a healthy one.
    ref.read(lastBoardControllerProvider.notifier).set(
          board.steps,
          truncated: board.hasGap,
        );
  }

  /// Whether the conversation is still going.
  ///
  /// Written as a `switch` so adding a phase forces a decision about it, rather
  /// than slipping through a default.
  static bool _isTalking(SessionPhase phase) => switch (phase) {
    SessionPhase.connecting ||
    SessionPhase.listening ||
    SessionPhase.senpaiSpeaking ||
    SessionPhase.senpaiTeaching ||
    SessionPhase.explainBack => true,
    SessionPhase.summarizing || SessionPhase.finished || SessionPhase.failed => false,
  };

  /// Phase while they are speaking; with a board up, that is senpai explaining.
  SessionPhase get _speakingPhase =>
      state.board.hasBoard ? SessionPhase.senpaiTeaching : SessionPhase.senpaiSpeaking;

  /// Phase while it is our turn; with a board up, that is teaching back.
  SessionPhase get _listeningPhase =>
      state.board.hasBoard ? SessionPhase.explainBack : SessionPhase.listening;

  void onSenpaiSpeaking(String text) {
    // A second path that stops the cue on the first caption, in case AgentState
    // was missed.
    unawaited(_lessonOpeningAudio?.senpaiStartedSpeaking() ?? Future<void>.value());
    state = state.copyWith(phase: _speakingPhase, lastSenpaiText: text);
  }

  void onUserTurn() {
    if (!_isTalking(state.phase)) return;
    state = state.copyWith(phase: _listeningPhase);
  }

  /// "I can't explain it."
  ///
  /// Passing is a recorded gap, not a shame, so senpai is told too. Without that,
  /// only our screen changes while senpai keeps waiting on the same question.
  Future<void> pass(String message) async {
    onUserTurn();
    try {
      await _room?.localParticipant?.sendText(
        message,
        options: SendTextOptions(topic: 'lk.chat'),
      );
    } catch (error) {
      // The conversation continues even if this does not land, so do not stall
      // the screen.
      //
      // But never end silently. The promise that passing is not shameful holds
      // only because a pass is recorded; undelivered, it never becomes a gap.
      // For that student it is just "I couldn't say it and nothing happened",
      // and the screen carries on as if fine, so neither they nor we can see it.
      //
      // `message` is not sent: the pass wording is speech aimed at the student
      // and does not belong in monitoring. The failure and the session_id are
      // enough.
      Telemetry.report(
        DegradationEvent.passNotSent(
          sessionId: _sessionId,
          phase: state.phase.name,
          // Type only. The factory accepts a `Type`, so the exception's
          // `toString()` (which can include endpoint URLs) cannot be passed.
          error: error.runtimeType,
        ),
      );
    }
  }

  /// Ends the conversation.
  ///
  /// The agent writes the karte and posts it to the server, so the app fetches
  /// `/v1/sessions/{id}/result`. Without that, both celebration and karte render
  /// empty.
  Future<void> finish() async {
    if (_finishing) return;
    _finishing = true;

    // The conversation is over. Letting the countdown run through teardown (a
    // few seconds) would make a finished conversation look still live.
    _ticker?.cancel();
    _ticker = null;

    final bool talked = _senpaiIdentity != null;

    // Move the screen first. Teardown waits seconds for the disconnect, so
    // placing this after `_teardown()` leaves the screen identical for seconds
    // after tapping "done for today" — no feedback, so people tap repeatedly.
    if (talked) {
      state = state.copyWith(phase: SessionPhase.summarizing);
    } else {
      // Senpai never arrived, so no karte is written. Give the reason at once.
      state = state.copyWith(
        phase: SessionPhase.failed,
        failure: SessionFailure.senpaiUnavailable,
      );
    }

    await _teardown();

    final String? sessionId = _sessionId;
    if (!talked) return;

    if (sessionId == null) {
      _publish(SessionOutcome(resultMissing: true, kind: _sessionKind));
      state = state.copyWith(phase: SessionPhase.finished, resultMissing: true);
      return;
    }

    try {
      final SessionResult? result = await ref.read(apiClientProvider).awaitSessionResult(
            sessionId,
            interval: _kartePollInterval,
            attempts: _karteGrace.inSeconds ~/ _kartePollInterval.inSeconds,
          );
      // The screen was left while waiting; there is nowhere to write back to.
      if (!ref.mounted) return;

      if (result == null) {
        // Generation did not finish in time; show the celebration and let it
        // fetch the karte.
        _publish(
          SessionOutcome(resultMissing: true, sessionId: sessionId, kind: _sessionKind),
        );
        state = state.copyWith(phase: SessionPhase.finished, resultMissing: true);
        return;
      }

      ref.read(latestKarteControllerProvider.notifier).set(result.karte);
      ref.read(progressControllerProvider.notifier).applyFromSession(result.progress);
      // The review queue is keepAlive, so force a refetch before karte or review
      // reads it again; otherwise candidates come from the stale open state.
      ref.invalidate(reviewControllerProvider);
      _publish(
        SessionOutcome(
          showPaywall: result.showPaywall,
          sessionId: sessionId,
          kind: _sessionKind,
        ),
      );
      state = state.copyWith(
        phase: SessionPhase.finished,
        showPaywall: result.showPaywall,
      );
    } catch (error) {
      if (!ref.mounted) return;
      _publish(
        SessionOutcome(resultMissing: true, sessionId: sessionId, kind: _sessionKind),
      );
      state = state.copyWith(
        phase: SessionPhase.finished,
        resultMissing: true,
        error: error,
      );
    }
  }

  /// Stores the result that outlives the AutoDispose conversation screen.
  void _publish(SessionOutcome outcome) {
    ref.read(sessionOutcomeControllerProvider.notifier).set(outcome);
  }

  /// Teardown must never throw.
  ///
  /// `_teardown()` is also called from failure handling (`connect`'s catch). An
  /// exception here would exit `connect` before the failure reaches the screen,
  /// leaving it on "listening". A cleanup failure must not destroy the
  /// conversation's outcome.
  Future<void> _teardown() async {
    _ticker?.cancel();
    _ticker = null;
    _senpaiWatchdog?.cancel();
    _senpaiWatchdog = null;

    final Room? room = _room;
    // Drop the reference first, so events arriving mid-teardown cannot touch a
    // room that is being closed.
    _room = null;

    // Detach the board first for the same reason: envelopes arriving mid-read
    // must not flow into a screen that no longer exists.
    _boardInbox = null;
    await _quietly(
      '板書の購読解除',
      () => room?.unregisterTextStreamHandler(boardChannelTopic),
    );

    final LessonOpeningAudio? openingAudio = _lessonOpeningAudio;
    _lessonOpeningAudio = null;
    await _quietly('授業冒頭のローカル音声停止', () => openingAudio?.stop());

    // Cancel subscriptions first, so the disconnect does not return as an event.
    await _quietly('字幕の購読解除', () => _transcriptSubscription?.cancel());
    _transcriptSubscription = null;
    await _quietly('字幕の破棄', () => _transcripts?.dispose());
    _transcripts = null;
    await _quietly('イベント購読の破棄', () => _events?.dispose());
    _events = null;

    // A room that failed to connect may never emit the disconnect completion
    // event, and the SDK throws TimeoutException after 10 seconds. Tear down
    // without waiting.
    await _quietly(
      'ルームの切断',
      () => room?.disconnect().timeout(_disconnectTimeout),
    );
    // Always run dispose even if the disconnect did not finish; the SDK's own
    // cleanup happens there.
    await _quietly('ルームの破棄', () => room?.dispose());
  }

  /// One teardown step; a failure moves on to the next.
  Future<void> _quietly(String what, FutureOr<void> Function() step) async {
    try {
      await step();
    } catch (error) {
      debugPrint('$what に失敗しました(片付けは続けます): $error');
    }
  }
}
