import 'package:flutter/material.dart';

import '../../../../common_widgets/board_reveal.dart';
import '../../../../theme/tokens.dart';
import '../../domain/board.dart';
import 'board_element_view.dart';
import 'board_style.dart';

/// The board itself: renders a list of `BoardStep`s by stacking them line by
/// line and never erasing.
///
/// [BoardChannelReceiver.currentSteps] is expected to go straight into [steps];
/// this widget knows nothing of LiveKit or the receiver and only draws what it
/// is handed.
///
/// Steps with `board == null` (acknowledgements and checks — voice only) leave
/// nothing on the board.
///
/// The surface lives here (see "the board is a blackboard" in
/// `board_style.dart`) rather than in callers, because three screens show a board
/// (lesson, karte, onboarding rehearsal). Letting callers draw the surface would
/// make it possible to get chalk colors with no board — white on white.
///
/// Horizontal padding also lives here, so callers must not add their own;
/// doubled padding drops the effective width below 340pt and pushes formulas
/// into horizontal scrolling.
class BoardView extends StatelessWidget {
  const BoardView({required this.steps, super.key});

  /// The board's inner padding, set to the same value callers used, so running
  /// full width leaves the effective width unchanged to the point.
  static const double padding = AppSpacing.lg;

  final List<BoardStep> steps;

  @override
  Widget build(BuildContext context) {
    final List<BoardStep> withBoard = steps.where((BoardStep s) => s.board != null).toList();

    if (withBoard.isEmpty) {
      return const SizedBox.shrink();
    }

    return ColoredBox(
      color: BoardStyle.surface,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: padding, vertical: AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            for (final BoardStep step in withBoard)
              Padding(
                // Key by index so a rebuild does not recreate the same step as a
                // new widget; recreating replays the writing animation from the
                // start and breaks the sense that earlier lines persist.
                key: ValueKey<int>(step.index),
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
                child: BoardReveal(child: BoardElementView(element: step.board!)),
              ),
          ],
        ),
      ),
    );
  }
}
