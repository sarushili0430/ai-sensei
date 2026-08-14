import 'package:flutter/material.dart';

import '../../domain/board.dart';
import 'board_coordinate_space.dart';
import 'board_style.dart';

/// Draws a circle (`BoardElement.circle`).
class CirclePainter extends CustomPainter {
  CirclePainter({required this.center, required this.r, this.labels});

  final BoardPoint center;
  final double r;
  final List<String>? labels;

  @override
  void paint(Canvas canvas, Size size) {
    if (r <= 0) {
      paintBoardElementError(canvas, size);
      return;
    }

    // Add 25% of the radius as padding for labels outside the circle.
    final double margin = r * 1.25;
    final BoardCoordinateSpace space = BoardCoordinateSpace(
      dataMinX: center.x - margin,
      dataMaxX: center.x + margin,
      dataMinY: center.y - margin,
      dataMaxY: center.y + margin,
      canvasSize: size,
    );

    final Offset canvasCenter = space.toCanvasPoint(center);
    final double radiusPx = r * space.uniformScale;

    canvas.drawCircle(
      canvasCenter,
      radiusPx,
      Paint()
        ..color = BoardStyle.chalk
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.4,
    );
    canvas.drawCircle(canvasCenter, 3, Paint()..color = BoardStyle.chalk);

    final List<String>? labelList = labels;
    if (labelList == null || labelList.isEmpty) return;

    // First: the centre's name, just below the centre.
    paintBoardLabel(canvas, labelList[0], canvasCenter + const Offset(0, 16));

    // Second: a radius annotation or similar, near the edge at 45 degrees up and
    // right — "r = 5" is conventionally written beside a diagonal radius.
    if (labelList.length > 1) {
      final Offset onEdge =
          canvasCenter + Offset(radiusPx * 0.7071, -radiusPx * 0.7071);
      canvas.drawLine(
        canvasCenter,
        onEdge,
        Paint()
          ..color = BoardStyle.chalkMuted
          ..strokeWidth = 1,
      );
      paintBoardLabel(canvas, labelList[1], onEdge + const Offset(18, -10));
    }

    // Third onwards: stacked below the centre. The spec caps it at three.
    for (int i = 2; i < labelList.length; i++) {
      paintBoardLabel(
        canvas,
        labelList[i],
        canvasCenter + Offset(0, 16 + 18.0 * (i - 1)),
      );
    }
  }

  @override
  bool shouldRepaint(covariant CirclePainter oldDelegate) =>
      oldDelegate.center != center || oldDelegate.r != r || oldDelegate.labels != labels;
}
