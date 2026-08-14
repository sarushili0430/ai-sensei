import 'package:flutter/foundation.dart';

import '../../session/domain/board.dart';

/// The board that outlives the lesson; what the karte reads back.
///
/// - The in-lesson `BoardSnapshot` dies with the AutoDispose conversation screen
/// - That one carries lesson-only fields (`gapReason`, `title`)
/// - Reading back needs just two things: what is written, and whether it is all
@immutable
class LastBoard {
  const LastBoard({this.steps = const <BoardStep>[], this.truncated = false});

  /// The accumulated steps. The board never erases earlier lines.
  final List<BoardStep> steps;

  /// This board is incomplete.
  ///
  /// - On detecting a delivery gap, the receiver stops accumulating
  /// - A truncated list is indistinguishable from a complete one
  /// - Staying silent reads as "that's all", which is riskier in the karte,
  ///   where there is no audio
  final bool truncated;

  bool get isEmpty => steps.isEmpty;

  /// Whether to show the truncation marker; hidden on an empty board, where it
  /// would just look broken.
  bool get showsTruncation => truncated && steps.isNotEmpty;

  static const LastBoard empty = LastBoard();
}
