import 'package:flutter/material.dart';

import '../../domain/board.dart';
import 'board_coordinate_space.dart';
import 'board_style.dart';
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

    // 定義域外(NaN)を挟むたびに線を切る。区間ごとに別々のPathとして描く
    // (最後の区間だけ描くと、途中で途切れた関数の前半が消えてしまう)。
    //
    // **漸近線も同じように切る。**tan(x) のような関数では、漸近線はふつう
    // 標本点と標本点の**あいだ**に来るので、両側の標本はどちらも有限のまま
    // 符号だけが反転する(+1e15 と -1e15 のように)。有限性だけを見て切ると、
    // その2点が直線で結ばれ、**不連続な場所に「つながっている」という
    // 数学的に嘘の線**が引かれる。板書は解法そのものなので、この嘘は許容できない。
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

  /// 隣り合う標本が不連続をまたいだか。
  ///
  /// 判定は「**1区間で、描画範囲の半分を超えて飛んだ**」こと。
  /// 標本は241点あるので、連続な関数なら急勾配でも1区間の差は範囲のごく一部に収まる
  /// (x^3 を [-10,10] で見ても、端で範囲の1%強でしかない)。
  /// 半分を超えるのは、実質的に値が飛んでいるとき — つまり不連続点だけ。
  ///
  /// 「上端の外と下端の外をまたいだか」では判定できない。描画範囲は
  /// **全標本から取っている**ので、漸近線の近くの巨大な値がそのまま範囲になり、
  /// 「範囲の外」が存在しなくなるため。
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
