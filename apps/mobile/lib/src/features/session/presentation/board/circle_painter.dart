import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import '../../domain/board.dart';
import 'board_coordinate_space.dart';

/// 円(`BoardElement.circle`)を描く。
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

    // ラベルが円の外に出る分の余白として半径の25%を足す。
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
        ..color = AppColors.ink
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.4,
    );
    canvas.drawCircle(canvasCenter, 3, Paint()..color = AppColors.ink);

    final List<String>? labelList = labels;
    if (labelList == null || labelList.isEmpty) return;

    // 1つ目: 中心の名前(中心のすぐ下)。
    paintBoardLabel(canvas, labelList[0], canvasCenter + const Offset(0, 16));

    // 2つ目: 半径の注記など。右上45度の縁のあたりに置く(「r = 5」のような
    // 半径の説明は、慣習的に斜めの半径線の近くに書かれることが多いため)。
    if (labelList.length > 1) {
      final Offset onEdge =
          canvasCenter + Offset(radiusPx * 0.7071, -radiusPx * 0.7071);
      canvas.drawLine(
        canvasCenter,
        onEdge,
        Paint()
          ..color = AppColors.inkMuted
          ..strokeWidth = 1,
      );
      paintBoardLabel(canvas, labelList[1], onEdge + const Offset(18, -10));
    }

    // 3つ目以降: 中心の下に縦に並べる。仕様上3つが上限。
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
