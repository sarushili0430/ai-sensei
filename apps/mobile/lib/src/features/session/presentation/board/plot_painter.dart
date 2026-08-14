import 'package:flutter/material.dart';

import '../../domain/board.dart';
import 'board_coordinate_space.dart';
import 'board_style.dart';
import 'plot_expression.dart';

/// Draws a function plot (`BoardElement.plot`).
///
/// `fn` is evaluated on the spot with [PlotExpression], since the server sends
/// the expression rather than its values — the function-expression form of
/// letting the LLM emit parameters only.
class PlotPainter extends CustomPainter {
  PlotPainter({required this.fn, required this.domain, required this.marks});

  final String fn;
  final BoardDomain domain;
  final List<PlotMark> marks;

  static const int _samples = 240;

  @override
  void paint(Canvas canvas, Size size) {
    final PlotExpression expression;
    try {
      expression = PlotExpression.parse(fn);
    } on FormatException {
      paintBoardElementError(canvas, size);
      return;
    }

    final List<double> ys = List<double>.generate(_samples + 1, (int i) {
      final double x = _xAt(i);
      try {
        return expression.evaluate(x);
      } on Object {
        return double.nan;
      }
    });

    double minY = double.infinity;
    double maxY = -double.infinity;
    for (final double y in ys) {
      if (y.isFinite) {
        minY = minY > y ? y : minY;
        maxY = maxY < y ? y : maxY;
      }
    }
    for (final PlotMark mark in marks) {
      minY = minY > mark.at.y ? mark.at.y : minY;
      maxY = maxY < mark.at.y ? mark.at.y : maxY;
    }
    if (!minY.isFinite || !maxY.isFinite) {
      // Every sample is outside the domain (a negative under sqrt, say), so
      // there is nothing to draw.
      paintBoardElementError(canvas, size);
      return;
    }
    if ((maxY - minY).abs() < 1e-9) {
      // A collapsed range (a constant function) gets vertical padding.
      minY -= 1;
      maxY += 1;
    }

    final BoardCoordinateSpace space = BoardCoordinateSpace(
      dataMinX: domain.min,
      dataMaxX: domain.max,
      dataMinY: minY,
      dataMaxY: maxY,
      canvasSize: size,
      preserveAspectRatio: false,
    );

    _paintAxes(canvas, size, space, minY, maxY);
    _paintCurve(canvas, space, ys, minY, maxY);
    _paintMarks(canvas, space);
  }

  double _xAt(int i) => domain.min + (domain.max - domain.min) * i / _samples;

  void _paintAxes(Canvas canvas, Size size, BoardCoordinateSpace space, double minY, double maxY) {
    final Paint framePaint = Paint()
      ..color = BoardStyle.chalkMuted.withValues(alpha: 0.4)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    canvas.drawRect(Offset.zero & size, framePaint);

    final Paint axisPaint = Paint()
      ..color = BoardStyle.chalkMuted
      ..strokeWidth = 1;
    // The x axis (y=0), drawn only when the range crosses it.
    if (minY <= 0 && maxY >= 0) {
      final Offset left = space.toCanvas(domain.min, 0);
      final Offset right = space.toCanvas(domain.max, 0);
      canvas.drawLine(left, right, axisPaint);
    }
    // The y axis (x=0).
    if (domain.min <= 0 && domain.max >= 0) {
      final Offset top = space.toCanvas(0, maxY);
      final Offset bottom = space.toCanvas(0, minY);
      canvas.drawLine(top, bottom, axisPaint);
    }
  }

  void _paintCurve(
    Canvas canvas,
    BoardCoordinateSpace space,
    List<double> ys,
    double minY,
    double maxY,
  ) {
    final Paint curvePaint = Paint()
      ..color = BoardStyle.chalkKey
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.4
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    // Break the line at every out-of-domain (NaN) sample, drawing each interval
    // as its own Path; drawing only the last interval would lose the first half
    // of a function that breaks partway.
    //
    // Asymptotes break the same way. For a function like tan(x) the asymptote
    // usually falls between samples, so both neighbours stay finite and only the
    // sign flips (+1e15 and -1e15). Breaking on finiteness alone would join them
    // with a straight line, drawing a mathematically false "it is continuous
    // here". The board is the working itself, so that lie is unacceptable.
    final double span = maxY - minY;
    Path? path;
    double? previous;
    for (int i = 0; i <= _samples; i++) {
      final double y = ys[i];
      if (!y.isFinite || (previous != null && _jumpsAcrossDiscontinuity(previous, y, span))) {
        if (path != null) {
          canvas.drawPath(path, curvePaint);
          path = null;
        }
        previous = y.isFinite ? y : null;
        if (!y.isFinite) {
          continue;
        }
      }
      final Offset point = space.toCanvas(_xAt(i), y);
      if (path == null) {
        path = Path()..moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
      previous = y;
    }
    if (path != null) {
      canvas.drawPath(path, curvePaint);
    }
  }

  /// Whether two adjacent samples straddle a discontinuity.
  ///
  /// The test is a jump of more than half the plotted range in one interval.
  /// With 241 samples, even a steep continuous function keeps one interval to a
  /// small fraction of the range (x^3 over [-10,10] is barely 1% at the edges).
  /// Exceeding half means the value effectively jumped — a discontinuity.
  ///
  /// Testing "crossed above the top and below the bottom" cannot work: the range
  /// is taken from all the samples, so huge values near an asymptote become the
  /// range and nothing is ever outside it.
  static bool _jumpsAcrossDiscontinuity(double a, double b, double span) {
    if (!a.isFinite || !b.isFinite || span <= 0) {
      return false;
    }
    return (a - b).abs() > span * 0.5;
  }

  void _paintMarks(Canvas canvas, BoardCoordinateSpace space) {
    for (final PlotMark mark in marks) {
      final Offset point = space.toCanvasPoint(mark.at);
      canvas.drawCircle(point, 4, Paint()..color = BoardStyle.chalkKey);
      canvas.drawCircle(
        point,
        4,
        Paint()
          ..color = BoardStyle.surface
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5,
      );
      final String? label = mark.label;
      if (label != null) {
        paintBoardLabel(canvas, label, point + const Offset(0, -14));
      }
    }
  }

  @override
  bool shouldRepaint(covariant PlotPainter oldDelegate) =>
      oldDelegate.fn != fn || oldDelegate.domain != domain || oldDelegate.marks != marks;
}
