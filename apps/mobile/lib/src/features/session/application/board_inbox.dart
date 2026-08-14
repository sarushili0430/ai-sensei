import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../../telemetry/telemetry.dart';
import '../domain/board.dart';

/// The board in a form the screen can render.
///
/// [BoardChannelReceiver] holds whether the contract is being met; this holds
/// what is currently written. They are separate so a contract violation never
/// erases what was already written: sharing one container for inspection state
/// and display state would drop the whole board on every violation.
@immutable
class BoardSnapshot {
  const BoardSnapshot({this.title, this.steps = const <BoardStep>[], this.gapReason});

  /// The board heading (`board_open`'s `title`): which problem this board is for.
  final String? title;

  /// The steps accumulated so far. Earlier lines are never erased; only
  /// `board_open` clears them.
  final List<BoardStep> steps;

  /// Why the board is truncated; null means healthy.
  ///
  /// Not user-facing copy — it is a technical description of the contract
  /// violation, while the screen shows a localized line. It is kept for matching
  /// against local logs during development, and as material for the degradation
  /// record (`Degradation.boardGap`).
  final String? gapReason;

  /// Whether lesson mode is active; the condition that switches the layout.
  ///
  /// Not decided by `title` alone, so the board still shows when `board_open`
  /// was lost and steps arrived first ([gapReason] reports that separately).
  bool get hasBoard => title != null || steps.isNotEmpty;

  /// Whether it is stopped in a truncated state.
  bool get hasGap => gapReason != null;

  static const BoardSnapshot empty = BoardSnapshot();
}

/// Turns envelopes from the data channel into a renderable board
/// ([BoardSnapshot]).
///
/// Deliberately knows nothing about LiveKit (it takes only strings and
/// envelopes), because this is the layer where behaviour on a gap is decided —
/// putting it somewhere that needs a real connection would make the failure mode
/// we most want to test untestable.
///
/// ## What happens on a gap (never swallowed silently)
///
/// A skipped `seq` / `index`, a wrong `session_id`, unparseable JSON — each is
/// one step from a board rendered full of holes (see [BoardContractViolation] in
/// `domain/board.dart`). Three rules:
///
///   1. Never erase what was already written. A gap means "nothing readable from
///      here on", not that earlier lines became false; erasing loses more.
///   2. Add nothing further to that board. Continuing would build a hole-riddled
///      board with no sign of where the hole is, and a student cannot tell
///      something is missing, so they learn it wrong. Showing a truncation
///      marker and stopping is safer.
///   3. Recover on the next `board_open`. Moving to another problem rebuilds the
///      board anyway, so that is the recovery point: one problem is lost, not
///      the whole session.
///
/// After recovery `seq` simply restarts (`expectedSeq` in
/// [BoardChannelReceiver]), so later gaps are still detected.
class BoardInbox {
  BoardInbox({required this.sessionId})
    : _receiver = BoardChannelReceiver(sessionId: sessionId);

  /// This connection's session, used to drop misaddressed envelopes.
  final String sessionId;

  BoardChannelReceiver _receiver;
  String? _title;
  String? _gapReason;

  /// The current board.
  BoardSnapshot get snapshot =>
      BoardSnapshot(title: _title, steps: _receiver.currentSteps, gapReason: _gapReason);

  /// Handles one complete envelope (a JSON string) read from the stream.
  ///
  /// Returns whether the board changed; if not, no repaint is needed. Envelopes
  /// that keep arriving after a truncation are quietly dropped here.
  bool acceptPayload(String payload) {
    final BoardChannelMessage message;
    try {
      message = BoardChannelMessage.fromJson(
        jsonDecode(payload) as Map<String, dynamic>,
      );
    } catch (error) {
      // An unreadable envelope means unknown contents, so also unknown what is
      // missing. Treat it as a gap — dropping it silently leaves holes.
      return _breakBoard('封筒を読めませんでした: $error');
    }
    return accept(message);
  }

  /// Handles a single envelope.
  bool accept(BoardChannelMessage message) {
    if (_gapReason != null) {
      // Never add to a truncated board; the only recovery point is moving to
      // another problem.
      if (message is! BoardOpenMessage) return false;
      _receiver = BoardChannelReceiver.resumingAt(sessionId: sessionId, seq: message.seq);
      _gapReason = null;
      _title = null;
    }

    try {
      _receiver.accept(message);
    } on BoardContractViolation catch (violation) {
      return _breakBoard(violation.message);
    }

    // Replace the heading only once accepted; doing it before validation would
    // let a misaddressed envelope swap the heading alone.
    if (message is BoardOpenMessage) _title = message.title;
    return true;
  }

  /// Marks the board truncated. The return value matches [accept]'s "changed".
  bool _breakBoard(String reason) {
    _gapReason = reason;

    // Never swallowed: this is the only way to notice the agent failing to send,
    // and it used to reach `debugPrint` alone, so production had zero
    // visibility. The screen shows a localized line, not this text.
    //
    // Throttled per board. If it broke before even `board_open` was readable
    // there is no board ID, so it falls back to per session (one report each).
    Telemetry.report(
      DegradationEvent.boardGap(
        sessionId: sessionId,
        boardId: _receiver.openBoardId,
        // The violation reason. Contains no student speech and no problem text —
        // `BoardContractViolation` builds it from seq and index only.
        reason: reason,
        stepsSoFar: _receiver.currentSteps.length,
      ),
    );
    return true;
  }
}
