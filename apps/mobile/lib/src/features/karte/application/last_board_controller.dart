import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../session/domain/board.dart';
import '../domain/last_board.dart';

part 'last_board_controller.g.dart';

/// The board senpai wrote in the last lesson.
///
/// - The lesson side is AutoDispose, so this is the only place it outlives
/// - It lives under karte because we store things with the consumer, not the
///   producer
/// - Its lifetime is one problem; the next `board_open` empties it naturally
/// - Written from exactly one place, `SessionController._applyBoard`
/// - Written on every change, not on `board_close` — the close never arrives
///   when a lesson ends early
@Riverpod(keepAlive: true)
class LastBoardController extends _$LastBoardController {
  @override
  LastBoard build() => LastBoard.empty;

  /// Replaces the board wholesale — this does not append, since the receiver has
  /// already accumulated.
  ///
  /// [truncated] is `BoardSnapshot.hasGap`. Omit it and a truncated board is
  /// stored as a healthy one (see [LastBoard.truncated]).
  void set(List<BoardStep> steps, {bool truncated = false}) => state = LastBoard(
        steps: List<BoardStep>.unmodifiable(steps),
        truncated: truncated,
      );

  /// Clears the board, for when the next problem started but no step has arrived
  /// yet.
  void clear() => state = LastBoard.empty;
}
