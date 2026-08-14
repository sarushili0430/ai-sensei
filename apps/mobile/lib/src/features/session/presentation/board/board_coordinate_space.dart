import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import '../../domain/board.dart';
import 'board_style.dart';
import 'dart:math' as math;

/// Converts mathematical coordinates into Canvas pixel coordinates.
///
/// The plot, triangle and circle painters all need the same conversion (board
/// coordinates are mathematical with y up, Canvas is pixels with y down), so it
/// lives here once.
class BoardCoordinateSpace {
  BoardCoordinateSpace({
    required double dataMinX,
    required double dataMaxX,
    required double dataMinY,
    required double dataMaxY,
    required this.canvasSize,
    this.padding = 20,
    this.preserveAspectRatio = true,
  }) {
    final double dataWidth = math.max(dataMaxX - dataMinX, 1e-9);
    final double dataHeight = math.max(dataMaxY - dataMinY, 1e-9);
    final double availableWidth = math.max(canvasSize.width - padding * 2, 1);
    final double availableHeight = math.max(canvasSize.height - padding * 2, 1);

    double scaleX = availableWidth / dataWidth;
    double scaleY = availableHeight / dataHeight;
    if (preserveAspectRatio) {
      // Different x and y scales distort circles into ellipses and stop right
      // angles looking right.
      final double uniform = math.min(scaleX, scaleY);
      scaleX = uniform;
      scaleY = uniform;
    }
    _scaleX = scaleX;
    _scaleY = scaleY;

    final double dataCenterX = (dataMinX + dataMaxX) / 2;
    final double dataCenterY = (dataMinY + dataMaxY) / 2;
    _originX = canvasSize.width / 2 - dataCenterX * _scaleX;
    _originY = canvasSize.height / 2 + dataCenterY * _scaleY;
  }

  final Size canvasSize;
  final double padding;
  final bool preserveAspectRatio;

  late final double _scaleX;
  late final double _scaleY;
  late final double _originX;
  late final double _originY;

  /// The shared scale, meaningful only under [preserveAspectRatio]. Used to
  /// convert lengths such as a circle's radius into pixels.
  double get uniformScale => _scaleX;

  Offset toCanvas(double x, double y) => Offset(_originX + x * _scaleX, _originY - y * _scaleY);

  Offset toCanvasPoint(BoardPoint p) => toCanvas(p.x, p.y);
}

/// Draws labels beside board graphics (vertex names, tick annotations), shared
/// so all three painters look the same.
void paintBoardLabel(Canvas canvas, String text, Offset anchor, {Color color = BoardStyle.chalk}) {
  final TextPainter painter = TextPainter(
    text: TextSpan(
      text: text,
      style: TextStyle(color: color, fontSize: 13, fontFamily: 'ZenMaruGothic'),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  painter.paint(canvas, anchor - Offset(painter.width / 2, painter.height / 2));
}

/// Fallback for when drawing fails (a malformed `fn`, say). Showing that
/// something broke beats vanishing silently.
void paintBoardElementError(Canvas canvas, Size size) {
  final Rect rect = Offset.zero & size;
  final Paint border = Paint()
    ..color = AppColors.hole.withValues(alpha: 0.5)
    ..style = PaintingStyle.stroke
    ..strokeWidth = 1.5;
  canvas.drawRect(rect.deflate(1), border);
  paintBoardLabel(canvas, '図を表示できません', rect.center, color: AppColors.hole);
}
