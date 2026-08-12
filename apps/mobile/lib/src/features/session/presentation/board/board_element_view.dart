import 'package:flutter/material.dart';

import '../../../../l10n/strings.dart';
import '../../domain/board.dart';
import 'board_speech.dart';
import 'board_style.dart';
import 'circle_painter.dart';
import 'figure_element_view.dart';
import 'latex_element_view.dart';
import 'plot_painter.dart';
import 'text_element_view.dart';
import 'triangle_painter.dart';

/// `BoardElement` の6枝を、対応する見た目に振り分ける。
///
/// 自由描画が無い(計画書§3-3)のと同じく、ここも6枝の`switch`(`.when`)で
/// 閉じている。新しいプリミティブを増やすときはここに枝を足すことになる
/// (契約側の `boardElementKinds` を増やすときと必ずセットで)。
class BoardElementView extends StatelessWidget {
  const BoardElementView({required this.element, super.key});

  final BoardElement element;

  @override
  Widget build(BuildContext context) {
    final Widget drawn = element.when(
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
      // **ここだけ painter を持たない。**中身はサーバが解いて描いたSVGで、
      // 図の語彙が増えてもこの枝は変わらない(D-21)。
      // `svg` はワイヤーに出る時点で必ず入っている(`ensureValidFigure`)。
      // 検査を通っていない経路から来た場合だけ null になるので、そのときは何も描かない。
      figure: (List<Map<String, dynamic>> items, String? svg, String? alt) =>
          svg == null ? const SizedBox.shrink() : FigureElementView(svg: svg),
    );

    // **読み上げは1行につき1つ。**
    //
    // `Math.tex` は記号ごとにウィジェットを積むので、包まないと
    // 「エックス」「ハット」「2」…と**バラバラに読まれる**(そもそも
    // `CustomPaint` の図形は1文字も読まれない)。中の断片を
    // [ExcludeSemantics] で消して、代わりに1つの文を置く。
    //
    // 板書はこのプロダクトの中心(計画書 §3-1)なので、ここが欠けると
    // 目が見えない生徒には**授業が存在しないのと同じ**になる。
    // 読み上げは端末側なので、§3-1 が抑えたかったTTSの原価には影響しない。
    return Semantics(
      label: describeElement(element, AppStrings.of(context)),
      // 数式も図形も、指で触って操作するものではない。
      readOnly: true,
      child: ExcludeSemantics(child: drawn),
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
