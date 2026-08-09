import 'package:flutter/material.dart';

import '../../domain/board.dart';
import 'board_style.dart';
import 'circle_painter.dart';
import 'latex_element_view.dart';
import 'plot_painter.dart';
import 'text_element_view.dart';
import 'triangle_painter.dart';

/// `BoardElement` の5枝を、対応する見た目に振り分ける。
///
/// 自由描画が無い(計画書§3-3)のと同じく、ここも5枝の`switch`(`.when`)で
/// 閉じている。新しいプリミティブを増やすときはここに枝を足すことになる
/// (契約側の `boardElementKinds` を増やすときと必ずセットで)。
class BoardElementView extends StatelessWidget {
  const BoardElementView({required this.element, super.key});

  final BoardElement element;

  @override
  Widget build(BuildContext context) {
    return element.when(
      latex: (String tex) => LatexElementView(tex: tex),
      text: (String body) => TextElementView(body: body),
      plot: (String fn, BoardDomain domain, List<PlotMark>? marks) => _GraphicBox(
        painter: PlotPainter(fn: fn, domain: domain, marks: marks ?? const <PlotMark>[]),
      ),
      triangle: (List<BoardPoint> vertices, List<String>? labels, List<AngleMark>? marks) =>
          _GraphicBox(
            painter: TrianglePainter(vertices: vertices, labels: labels, marks: marks),
          ),
      circle: (BoardPoint center, double r, List<String>? labels) =>
          _GraphicBox(painter: CirclePainter(center: center, r: r, labels: labels)),
    );
  }
}

/// plot/triangle/circle に共通の器。板書の1手順として自然な高さに収める。
class _GraphicBox extends StatelessWidget {
  const _GraphicBox({required this.painter});

  final CustomPainter painter;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: BoardStyle.graphicHeight,
      child: CustomPaint(painter: painter),
    );
  }
}
