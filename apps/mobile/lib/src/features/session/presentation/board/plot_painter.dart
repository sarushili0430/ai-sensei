import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import '../../domain/board.dart';
import 'board_coordinate_space.dart';
import 'plot_expression.dart';

/// 関数グラフ(`BoardElement.plot`)を描く。
///
/// `fn` は [PlotExpression] でその場で評価する(サーバから式の値ではなく
/// 式そのものが届くため。§3-3「LLMにはパラメータだけ吐かせる」の関数式版)。
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
      // 全点が定義域外(sqrtの負など)。描くものが無い。
      paintBoardElementError(canvas, size);
      return;
    }
    if ((maxY - minY).abs() < 1e-9) {
      // 定数関数などレンジが潰れる場合、上下に余白を作る。
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
    _paintCurve(canvas, space, ys);
    _paintMarks(canvas, space);
  }

  double _xAt(int i) => domain.min + (domain.max - domain.min) * i / _samples;

  void _paintAxes(Canvas canvas, Size size, BoardCoordinateSpace space, double minY, double maxY) {
    final Paint framePaint = Paint()
      ..color = AppColors.border
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    canvas.drawRect(Offset.zero & size, framePaint);

    final Paint axisPaint = Paint()
      ..color = AppColors.inkMuted
      ..strokeWidth = 1;
    // y=0 の軸(x軸)。定義域がまたいでいるときだけ描く。
    if (minY <= 0 && maxY >= 0) {
      final Offset left = space.toCanvas(domain.min, 0);
      final Offset right = space.toCanvas(domain.max, 0);
      canvas.drawLine(left, right, axisPaint);
    }
    // x=0 の軸(y軸)。
    if (domain.min <= 0 && domain.max >= 0) {
      final Offset top = space.toCanvas(0, maxY);
      final Offset bottom = space.toCanvas(0, minY);
      canvas.drawLine(top, bottom, axisPaint);
    }
  }

  void _paintCurve(Canvas canvas, BoardCoordinateSpace space, List<double> ys) {
    final Paint curvePaint = Paint()
      ..color = AppColors.blue
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.4
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    // 定義域外(NaN)を挟むたびに線を切る。区間ごとに別々のPathとして描く
    // (最後の区間だけ描くと、途中で途切れた関数の前半が消えてしまう)。
    Path? path;
    for (int i = 0; i <= _samples; i++) {
      final double y = ys[i];
      if (!y.isFinite) {
        if (path != null) {
          canvas.drawPath(path, curvePaint);
          path = null;
        }
        continue;
      }
      final Offset point = space.toCanvas(_xAt(i), y);
      if (path == null) {
        path = Path()..moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
    }
    if (path != null) {
      canvas.drawPath(path, curvePaint);
    }
  }

  void _paintMarks(Canvas canvas, BoardCoordinateSpace space) {
    for (final PlotMark mark in marks) {
      final Offset point = space.toCanvasPoint(mark.at);
      canvas.drawCircle(point, 4, Paint()..color = AppColors.hole);
      canvas.drawCircle(
        point,
        4,
        Paint()
          ..color = AppColors.surface
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
