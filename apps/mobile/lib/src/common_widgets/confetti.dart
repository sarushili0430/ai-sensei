import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// Celebration confetti, falling once behind the celebration screen.
///
/// Delight comes from color and paper, never from points, stars or XP.
/// The colors reuse the app's vocabulary — yellow (said it), pink (gap),
/// orange (streak) — so the color alone says a gap was filled.
class ConfettiBurst extends StatefulWidget {
  const ConfettiBurst({this.pieces = 26, this.looping = false, super.key});

  final int pieces;

  /// Whether to keep falling.
  ///
  /// A one-shot burst ends in ~2s, which looks frozen if the screen then
  /// keeps you waiting. Loop while waiting, then finish with a last burst.
  final bool looping;

  @override
  State<ConfettiBurst> createState() => _ConfettiBurstState();
}

class _ConfettiBurstState extends State<ConfettiBurst> with SingleTickerProviderStateMixin {
  /// One-shot burst.
  static const Duration _burst = Duration(milliseconds: 2200);

  /// One loop while waiting — unhurried, since the screen is stalling.
  static const Duration _loop = Duration(milliseconds: 4200);

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.looping ? _loop : _burst,
  );
  late final List<_Piece> _confetti = _buildPieces(widget.pieces);
  bool _started = false;

  /// Frame drawn under reduced motion: not blank, but the moment the paper
  /// has spread out. Motion sensitivity does not mean skipping the party.
  static const double _stillFrame = 0.35;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      _controller.value = _stillFrame;
      return;
    }
    if (widget.looping) {
      _controller.repeat();
    } else {
      _controller.forward();
    }
  }

  @override
  void didUpdateWidget(ConfettiBurst oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.looping == widget.looping) return;
    if (AppMotion.isReduced(context)) return;

    // `repeat()` runs at the current duration, so swap it in first.
    if (widget.looping) {
      _controller
        ..duration = _loop
        ..repeat();
    } else {
      // What we waited for arrived: stop looping and play one last burst.
      _controller
        ..duration = _burst
        ..forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: IgnorePointer(
        // Falls behind the content; do not repaint the text on top.
        child: RepaintBoundary(
          child: AnimatedBuilder(
            animation: _controller,
            builder: (BuildContext context, Widget? child) => CustomPaint(
              painter: _ConfettiPainter(
                pieces: _confetti,
                progress: _controller.value,
                looping: widget.looping,
              ),
              size: Size.infinite,
            ),
          ),
        ),
      ),
    );
  }
}

/// One piece of paper. Position and spin come from a fixed seed, so
/// goldens stay stable.
List<_Piece> _buildPieces(int count) {
  final math.Random random = math.Random(20260930);
  const List<Color> palette = <Color>[
    AppColors.said,
    AppColors.hole,
    AppColors.streak,
    AppColors.blue,
  ];

  return List<_Piece>.generate(count, (int i) {
    return _Piece(
      x: random.nextDouble(),
      delay: random.nextDouble() * 0.35,
      speed: 0.75 + random.nextDouble() * 0.5,
      drift: (random.nextDouble() - 0.5) * 0.22,
      spin: (random.nextDouble() - 0.5) * 8,
      width: 5 + random.nextDouble() * 5,
      height: 8 + random.nextDouble() * 6,
      color: palette[i % palette.length],
    );
  }, growable: false);
}

@immutable
class _Piece {
  const _Piece({
    required this.x,
    required this.delay,
    required this.speed,
    required this.drift,
    required this.spin,
    required this.width,
    required this.height,
    required this.color,
  });

  final double x;
  final double delay;
  final double speed;
  final double drift;
  final double spin;
  final double width;
  final double height;
  final Color color;
}

class _ConfettiPainter extends CustomPainter {
  const _ConfettiPainter({
    required this.pieces,
    required this.progress,
    this.looping = false,
  });

  final List<_Piece> pieces;
  final double progress;
  final bool looping;

  @override
  void paint(Canvas canvas, Size size) {
    for (final _Piece piece in pieces) {
      // One-shot: per-piece speed differences produce the scatter.
      //
      // Looping: same speed, staggered phase. Varying speed makes phases
      // converge each cycle into bursts separated by empty gaps.
      final double local = looping
          ? (progress + piece.delay + piece.x) % 1.0
          : (progress - piece.delay) * piece.speed;
      if (local <= 0) continue;

      // Remove once fallen; piling paper up weighs down the bottom.
      final double fall = local * 1.25;
      if (fall > 1.2) continue;

      final double dy = -0.15 + fall;
      final double dx = piece.x + piece.drift * math.sin(local * math.pi * 2);
      final double fade = fall > 0.85 ? (1.2 - fall) / 0.35 : 1.0;

      canvas.save();
      canvas.translate(dx * size.width, dy * size.height);
      canvas.rotate(local * piece.spin);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(
            center: Offset.zero,
            width: piece.width,
            // Flutter: a flat sheet turning over.
            height: piece.height * math.cos(local * piece.spin).abs().clamp(0.25, 1.0),
          ),
          const Radius.circular(2),
        ),
        Paint()..color = piece.color.withValues(alpha: 0.85 * fade.clamp(0.0, 1.0)),
      );
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_ConfettiPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.looping != looping;
}
