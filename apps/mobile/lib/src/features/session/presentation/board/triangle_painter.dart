import 'package:flutter/material.dart';

import '../../domain/board.dart';
import 'board_coordinate_space.dart';
import 'board_style.dart';
import 'dart:math' as math;

/// Draws a triangle (`BoardElement.triangle`).
///
/// It assumes `ensureValidTriangle` (inside `BoardChannelReceiver.accept()`) has
/// already confirmed exactly 3 `vertices`. The length is re-checked defensively
/// here, not to double-validate but because this painter can be called from
/// local tests that skip the receiving path.
class TrianglePainter extends CustomPainter {
  TrianglePainter({required this.vertices, this.labels, this.marks});

  final List<BoardPoint> vertices;
  final List<String>? labels;
  final List<AngleMark>? marks;

  @override
  void paint(Canvas canvas, Size size) {
    if (vertices.length != 3) {
      paintBoardElementError(canvas, size);
      return;
    }

    final double minX = vertices.map((BoardPoint p) => p.x).reduce(math.min);
    final double maxX = vertices.map((BoardPoint p) => p.x).reduce(math.max);
    final double minY = vertices.map((BoardPoint p) => p.y).reduce(math.min);
    final double maxY = vertices.map((BoardPoint p) => p.y).reduce(math.max);

    final BoardCoordinateSpace space = BoardCoordinateSpace(
      // A little padding in data coordinates for labels that stick out.
      dataMinX: minX,
      dataMaxX: maxX,
      dataMinY: minY,
      dataMaxY: maxY,
      canvasSize: size,
      padding: 32,
    );

    final List<Offset> points = vertices.map(space.toCanvasPoint).toList();
    final Offset centroid = (points[0] + points[1] + points[2]) / 3;

    final Path path = Path()
      ..moveTo(points[0].dx, points[0].dy)
      ..lineTo(points[1].dx, points[1].dy)
      ..lineTo(points[2].dx, points[2].dy)
      ..close();
    canvas.drawPath(
      path,
      Paint()
        ..color = BoardStyle.chalk
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.4
        ..strokeJoin = StrokeJoin.round,
    );

    final List<String>? labelsList = labels;
    if (labelsList != null && labelsList.length == 3) {
      for (int i = 0; i < 3; i++) {
        final Offset outward = _outward(points[i], centroid, 16);
        paintBoardLabel(canvas, labelsList[i], points[i] + outward);
      }
    }

    final List<AngleMark>? markList = marks;
    if (markList != null) {
      for (final AngleMark mark in markList) {
        if (mark.vertex < 0 || mark.vertex > 2) continue;
        _paintAngleMark(canvas, points, mark);
      }
    }
  }

  /// [from] pushed [distance] outwards from the centroid, so labels sit outside
  /// the triangle rather than inside it.
  Offset _outward(Offset from, Offset centroid, double distance) {
    final Offset direction = from - centroid;
    final double length = direction.distance;
    if (length < 1e-6) return Offset(0, -distance);
    return direction / length * distance;
  }

  void _paintAngleMark(Canvas canvas, List<Offset> points, AngleMark mark) {
    final Offset vertex = points[mark.vertex];
    final Offset other1 = points[(mark.vertex + 1) % 3];
    final Offset other2 = points[(mark.vertex + 2) % 3];

    final Offset dir1 = other1 - vertex;
    final Offset dir2 = other2 - vertex;
    final double len1 = dir1.distance;
    final double len2 = dir2.distance;
    if (len1 < 1e-6 || len2 < 1e-6) return;
    final Offset unit1 = dir1 / len1;
    final Offset unit2 = dir2 / len2;

    final Paint markPaint = Paint()
      ..color = BoardStyle.chalkKey
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;

    if (mark.kind == AngleMarkKind.rightAngle) {
      const double side = 12;
      final Offset p1 = vertex + unit1 * side;
      final Offset p2 = vertex + unit1 * side + unit2 * side;
      final Offset p3 = vertex + unit2 * side;
      final Path square = Path()
        ..moveTo(p1.dx, p1.dy)
        ..lineTo(p2.dx, p2.dy)
        ..lineTo(p3.dx, p3.dy);
      canvas.drawPath(square, markPaint);
    } else {
      final double angle1 = math.atan2(unit1.dy, unit1.dx);
      double sweep = math.atan2(unit2.dy, unit2.dx) - angle1;
      while (sweep <= -math.pi) {
        sweep += 2 * math.pi;
      }
      while (sweep > math.pi) {
        sweep -= 2 * math.pi;
      }
      const double radius = 18;
      canvas.drawArc(
        Rect.fromCircle(center: vertex, radius: radius),
        angle1,
        sweep,
        false,
        markPaint,
      );
    }

    final String? label = mark.label;
    if (label != null) {
      final Offset bisector = unit1 + unit2;
      final double bisectorLength = bisector.distance;
      final Offset placement = bisectorLength < 1e-6
          ? vertex + const Offset(0, -24)
          : vertex + bisector / bisectorLength * 26;
      paintBoardLabel(canvas, label, placement, color: BoardStyle.chalkKey);
    }
  }

  @override
  bool shouldRepaint(covariant TrianglePainter oldDelegate) =>
      oldDelegate.vertices != vertices || oldDelegate.labels != labels || oldDelegate.marks != marks;
}
