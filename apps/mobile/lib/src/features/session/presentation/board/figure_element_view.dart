import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'board_style.dart';

/// Draws a construction. The content is SVG the server solved and rendered; this
/// only displays it.
///
/// The figure vocabulary (triangles, sign tables, transition diagrams, box
/// plots…) can grow without changing this file, because the vocabulary lives on
/// the server (`@ai-sensei/figure`) and the device always receives one SVG. A
/// painter per primitive would have meant touching five files per new item.
///
/// It matches the board's width.
///
/// It used to fit [BoardStyle.graphicHeight] and centre horizontally at the
/// SVG's own ratio. At 320x224 the SVG then sat in a box narrower than the
/// board's effective width (345pt), while formulas and notes ran full width from
/// the left edge, so the figure alone looked inset (reported on device as
/// "figure and formula widths do not line up").
///
/// So the width matches the board and the height follows the ratio. The SVG
/// aspect is pinned near 10:7 by `@ai-sensei/figure`, so 345pt wide lands around
/// 240pt — not too large for a single board step. Only a maximum is imposed, so
/// a tall figure (stacked number lines and the like) cannot fill the screen in
/// one step.
class FigureElementView extends StatelessWidget {
  const FigureElementView({required this.svg, super.key});

  /// Height cap for one figure. The board stacks, so a step filling the screen
  /// would push earlier lines out of view.
  static const double maxHeight = 260;

  final String svg;

  @override
  Widget build(BuildContext context) {
    // Measure the width before passing it. `width: double.infinity` also
    // stretches the height to the box (`BoxFit.contain` adds vertical padding)
    // and the figure looks like it floats. With a concrete width, the height
    // follows the SVG's `viewBox` ratio.
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) => ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: maxHeight),
        child: SvgPicture.string(
          svg,
          width: constraints.maxWidth.isFinite ? constraints.maxWidth : null,
          fit: BoxFit.contain,
          alignment: Alignment.center,
          // The caller adds exactly one announcement; adding one here would be
          // read twice alongside `BoardElementView`'s [Semantics].
          excludeFromSemantics: true,
          // A malformed SVG yields an empty board line rather than a red error
          // screen: losing one line costs less than crashing mid-lesson (the same
          // call as "stop on breakage, but never erase what is there").
          placeholderBuilder: (BuildContext context) => const SizedBox.shrink(),
        ),
      ),
    );
  }
}
