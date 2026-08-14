import 'dart:async';
import 'dart:math' as math;
// Needed to measure per-line height; not re-exported via material.
import 'dart:ui' show BoxHeightStyle;

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// Highlighter pen — the app's visual language, rooted in student
/// notebook culture. Yellow = said it, pink = a gap.
///
/// The stroke is drawn left to right: the karte is written after the
/// conversation, so watching it drawn reads as a record of your own
/// explanation. Stagger [delay] to draw multi-line text top down.
enum MarkerColor {
  said(AppColors.said),
  hole(AppColors.hole);

  const MarkerColor(this.color);
  final Color color;
}

class MarkerText extends StatefulWidget {
  const MarkerText(this.text, {required this.marker, this.delay = Duration.zero, super.key});

  final String text;
  final MarkerColor marker;

  /// Delay before the stroke starts; stagger it to draw lines in order.
  final Duration delay;

  @override
  State<MarkerText> createState() => _MarkerTextState();
}

class _MarkerTextState extends State<MarkerText> with SingleTickerProviderStateMixin {
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

    // Reduced motion: place it fully drawn.
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

  static const EdgeInsets _padding = EdgeInsets.symmetric(
    horizontal: AppSpacing.xs,
    vertical: AppSpacing.xs / 2,
  );

  @override
  Widget build(BuildContext context) {
    // Pen speed. Constant velocity feels mechanical, so ease out at the end.
    final Animation<double> progress = CurvedAnimation(parent: _controller, curve: AppCurves.enter);
    final TextStyle? style = Theme.of(context).textTheme.bodyLarge;

    return AnimatedBuilder(
      animation: progress,
      builder: (BuildContext context, Widget? child) => CustomPaint(
        painter: _MarkerPainter(
          text: widget.text,
          style: style,
          textScaler: MediaQuery.textScalerOf(context),
          textDirection: Directionality.of(context),
          padding: _padding,
          color: widget.marker.color,
          progress: progress.value,
        ),
        child: child,
      ),
      child: Padding(
        padding: _padding,
        child: Text(widget.text, style: style),
      ),
    );
  }
}

/// Paints the lower half of the text, with slightly offset ends so it
/// reads as hand-drawn.
///
/// Drawn line by line: one band across wrapped text would leave the first
/// line bare and look like an underline rather than a highlighter. The pen
/// lifts at each line end, so lines fill top down.
///
/// Line positions come from re-laying out the same string with the same
/// style, textScaler and width as [Text], so the metrics match.
class _MarkerPainter extends CustomPainter {
  const _MarkerPainter({
    required this.text,
    required this.style,
    required this.textScaler,
    required this.textDirection,
    required this.padding,
    required this.color,
    required this.progress,
  });

  final String text;
  final TextStyle? style;
  final TextScaler textScaler;
  final TextDirection textDirection;
  final EdgeInsets padding;
  final Color color;

  /// 0 = not drawn yet, 1 = fully drawn.
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0 || text.isEmpty) return;

    final List<Rect> lines = _lineRects(size);
    if (lines.isEmpty) return;

    // The nib runs across lines; how far along the total distance we are.
    final double total = lines.fold<double>(0, (double sum, Rect it) => sum + it.width);
    double travelled = progress * total;
    final Paint paint = Paint()..color = color.withValues(alpha: 0.55);

    for (final Rect line in lines) {
      if (travelled <= 0) break;
      final double drawn = math.min(line.width, travelled);
      travelled -= drawn;

      final double top = line.top + line.height * 0.45;
      final double right = line.left + math.max(drawn, 1);
      final Path path = Path()
        ..moveTo(line.left, top + 1)
        ..lineTo(math.max(right - 2, line.left), top)
        ..lineTo(right, line.bottom - 1)
        ..lineTo(line.left - 1, line.bottom)
        ..close();
      canvas.drawPath(path, paint);
    }
  }

  /// Per-line rects; boxes sharing a top edge are merged into one line.
  List<Rect> _lineRects(Size size) {
    final TextPainter painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: textDirection,
      textScaler: textScaler,
    )..layout(maxWidth: size.width - padding.horizontal);

    final List<TextBox> boxes = painter.getBoxesForSelection(
      TextSelection(baseOffset: 0, extentOffset: text.length),
      boxHeightStyle: BoxHeightStyle.max,
    );

    final List<Rect> lines = <Rect>[];
    for (final TextBox box in boxes) {
      final Rect rect = box.toRect().shift(Offset(padding.left, padding.top));
      if (lines.isNotEmpty && (lines.last.top - rect.top).abs() < 0.5) {
        lines[lines.length - 1] = lines.last.expandToInclude(rect);
      } else {
        lines.add(rect);
      }
    }
    return lines;
  }

  @override
  bool shouldRepaint(_MarkerPainter oldDelegate) =>
      oldDelegate.color != color ||
      oldDelegate.progress != progress ||
      oldDelegate.text != text ||
      oldDelegate.style != style ||
      oldDelegate.textScaler != textScaler;
}
