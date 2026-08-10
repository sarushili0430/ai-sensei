import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import '../../domain/board.dart';

/// 「数学の座標」を「Canvasのピクセル座標」に変換する。
///
/// [plot]/[triangle]/[circle] の3つのpainterが同じ変換ロジックを必要とする
/// (板書の座標は数学座標・y上向き、Canvasはピクセル座標・y下向き)ので、
/// ここに1つだけ置く。
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
      // 円・三角形は縦横で縮尺が違うと歪む(円が楕円に、直角が直角に見えなくなる)。
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

  /// [preserveAspectRatio] のときだけ意味を持つ、縦横共通の縮尺。
  /// 半径のような「長さ」をピクセルに変換するのに使う(円のrなど)。
  double get uniformScale => _scaleX;

  Offset toCanvas(double x, double y) => Offset(_originX + x * _scaleX, _originY - y * _scaleY);

  Offset toCanvasPoint(BoardPoint p) => toCanvas(p.x, p.y);
}

/// 板書の図形に添えるラベル(頂点名・目盛の注記)を描く。
/// 3つのpainterで同じ見た目にするための共通処理。
void paintBoardLabel(Canvas canvas, String text, Offset anchor, {Color color = AppColors.ink}) {
  final TextPainter painter = TextPainter(
    text: TextSpan(
      text: text,
      style: TextStyle(color: color, fontSize: 13, fontFamily: 'ZenMaruGothic'),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  painter.paint(canvas, anchor - Offset(painter.width / 2, painter.height / 2));
}

/// 描けなかったとき(壊れた `fn` 等)の代わりの表示。
/// 沈黙して消えるより、何かが壊れていることを示す(黙ってクラッシュさせない)。
void paintBoardElementError(Canvas canvas, Size size) {
  final Rect rect = Offset.zero & size;
  final Paint border = Paint()
    ..color = AppColors.hole.withValues(alpha: 0.5)
    ..style = PaintingStyle.stroke
    ..strokeWidth = 1.5;
  canvas.drawRect(rect.deflate(1), border);
  paintBoardLabel(canvas, '図を表示できません', rect.center, color: AppColors.hole);
}
