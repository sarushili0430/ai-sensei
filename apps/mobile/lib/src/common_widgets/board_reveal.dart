import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// A board line being "written".
///
/// Generalizes [MarkerText]'s progress-driven `CustomPainter` from text
/// underlines to any widget (formulas, figures): a clip edge sweeps left
/// to right, revealing whatever the nib has passed. The lifecycle
/// (`AnimationController` -> delayed start via `Timer` ->
/// `AppMotion.isReduced` shortcut -> `dispose`) mirrors `MarkerText`.
///
/// The board never erases earlier lines, so sharing `AppDurations.draw`
/// (420ms, the marker speed) keeps board and karte in one motion language.
class BoardReveal extends StatefulWidget {
  const BoardReveal({required this.child, this.delay = Duration.zero, super.key});

  final Widget child;

  /// Delay before drawing, for deliberately staggering multiple lines.
  /// Normal streaming draws each line on arrival, so zero is fine.
  final Duration delay;

  @override
  State<BoardReveal> createState() => _BoardRevealState();
}

class _BoardRevealState extends State<BoardReveal> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppDurations.draw,
  );
  Timer? _timer;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      _controller.value = 1;
      return;
    }
    if (widget.delay == Duration.zero) {
      _controller.forward();
    } else {
      _timer = Timer(widget.delay, () {
        if (mounted) _controller.forward();
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Animation<double> progress = CurvedAnimation(parent: _controller, curve: AppCurves.enter);

    return AnimatedBuilder(
      animation: progress,
      builder: (BuildContext context, Widget? child) =>
          ClipRect(clipper: _LeftToRightClipper(progress.value), child: child),
      child: widget.child,
    );
  }
}

class _LeftToRightClipper extends CustomClipper<Rect> {
  const _LeftToRightClipper(this.progress);

  /// 0 = nothing visible, 1 = fully visible.
  final double progress;

  @override
  Rect getClip(Size size) => Rect.fromLTWH(0, 0, size.width * progress, size.height);

  @override
  bool shouldReclip(covariant _LeftToRightClipper oldClipper) => oldClipper.progress != progress;
}
