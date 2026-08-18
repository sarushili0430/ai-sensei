import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 板書の要素8枝。**板の上に置いて見ること**([onBoard])。
///
/// golden(`test/golden/board_elements_golden_test.dart`)は「崩れていないか」を
/// 見ているので、式や文はfixtureに固定してある。こちらは逆に**中身を変えられる**
/// 側で、長い式・長い文を入れたときに縮小や折り返しがどう効くかを手で確かめる。
@widgetbook.UseCase(name: 'latex(式)', type: BoardElementView)
Widget buildLatexElementUseCase(BuildContext context) {
  return onBoard(
    BoardElementView(
      element: BoardElement.latex(
        tex: context.knobs.string(
          label: 'TeX',
          initialValue: r'D = (-3)^2 - 4 \cdot 1 \cdot 2 = 9 - 8 = 1',
          maxLines: 2,
        ),
      ),
    ),
  );
}

/// 実効幅を超える式。**縮小率70%を下回ると横スクロールに落ちる**
/// (`BoardStyle.latexMinScale`)。落ちたあとも読めるかを見る。
@widgetbook.UseCase(name: 'latex(幅を超える)', type: BoardElementView)
Widget buildLatexOverflowElementUseCase(BuildContext context) {
  return onBoard(
    const BoardElementView(
      element: BoardElement.latex(
        tex: r'(x+1)(x+2)(x+3)(x+4) = x^4 + 10x^3 + 35x^2 + 50x + 24',
      ),
    ),
  );
}

@widgetbook.UseCase(name: 'text(注記)', type: BoardElementView)
Widget buildTextElementUseCase(BuildContext context) {
  return onBoard(
    BoardElementView(
      element: BoardElement.text(
        body: context.knobs.string(
          label: '本文',
          initialValue: 'a = 1, b = -3, c = 2',
          maxLines: 3,
        ),
      ),
    ),
  );
}

@widgetbook.UseCase(name: 'plot(グラフ)', type: BoardElementView)
Widget buildPlotElementUseCase(BuildContext context) {
  return onBoard(
    BoardElementView(
      element: BoardElement.plot(
        fn: context.knobs.string(label: '式', initialValue: 'x^2 - 3*x + 2'),
        domain: BoardDomain(
          min: context.knobs.double.slider(
            label: '定義域の左',
            initialValue: -1,
            min: -10,
            max: 0,
            divisions: 10,
          ),
          max: context.knobs.double.slider(
            label: '定義域の右',
            initialValue: 4,
            min: 1,
            max: 10,
            divisions: 9,
          ),
        ),
        marks: const <PlotMark>[
          PlotMark(at: BoardPoint(x: 1, y: 0), label: 'x = 1'),
          PlotMark(at: BoardPoint(x: 2, y: 0), label: 'x = 2'),
        ],
      ),
    ),
  );
}

/// 頂点名・直角マーク・角のマーク。
@widgetbook.UseCase(name: 'triangle(三角形)', type: BoardElementView)
Widget buildTriangleElementUseCase(BuildContext context) {
  return onBoard(
    const BoardElementView(
      element: BoardElement.triangle(
        vertices: <BoardPoint>[
          BoardPoint(x: 0, y: 0),
          BoardPoint(x: 4, y: 0),
          BoardPoint(x: 0, y: 3),
        ],
        labels: <String>['A', 'B', 'C'],
        marks: <AngleMark>[
          AngleMark(vertex: 0, kind: AngleMarkKind.rightAngle),
          AngleMark(vertex: 1, kind: AngleMarkKind.angle, label: 'θ'),
        ],
      ),
    ),
  );
}

@widgetbook.UseCase(name: 'circle(円)', type: BoardElementView)
Widget buildCircleElementUseCase(BuildContext context) {
  return onBoard(
    BoardElementView(
      element: BoardElement.circle(
        center: const BoardPoint(x: 0, y: 0),
        r: context.knobs.double.slider(
          label: '半径',
          initialValue: 5,
          min: 1,
          max: 10,
          divisions: 9,
        ),
        labels: const <String>['O', 'r = 5'],
      ),
    ),
  );
}

/// 英語の板書。`focus` は `text` の**部分文字列でなければならない**
/// (`ensureValidSentence`)。外すと下線が引かれないので、
/// 打ち替えて確かめられるようにしてある。
@widgetbook.UseCase(name: 'sentence(英語の例文)', type: BoardElementView)
Widget buildSentenceElementUseCase(BuildContext context) {
  return onBoard(
    BoardElementView(
      element: BoardElement.sentence(
        text: context.knobs.string(
          label: '例文',
          initialValue: 'I have lived here for ten years.',
          maxLines: 2,
        ),
        gloss: context.knobs.string(
          label: '訳',
          initialValue: '10年間ここに住んでいる(今も)',
          maxLines: 2,
        ),
        focus: context.knobs.string(label: '下線(部分文字列)', initialValue: 'have lived'),
      ),
    ),
  );
}

/// 2列の対比表。列はちょうど2つ、各行も2マス(`ensureValidCompare`)。
@widgetbook.UseCase(name: 'compare(対比表)', type: BoardElementView)
Widget buildCompareElementUseCase(BuildContext context) {
  return onBoard(
    const BoardElementView(
      element: BoardElement.compare(
        title: '現在完了 と 過去形',
        columns: <String>['現在完了', '過去形'],
        rows: <List<String>>[
          <String>['have + 過去分詞', '過去形'],
          <String>['今とつながっている', '今のことは言っていない'],
        ],
      ),
    ),
  );
}

/// 作図。**端末はSVGを描くだけ**で、座標を解いているのはサーバ(`@ai-sensei/figure`)。
///
/// golden にこの枝は無い(サーバが出すSVGを固定できないため)ので、
/// 目で見られる場所はここだけになる。下のSVGは実際に `drawFigure` が出したもの:
///
/// ```
/// [{"pt":"A","at":[0,0]},
///  {"pt":"B","from":"A","dist":6,"deg":0},
///  {"pt":"C","from":"A","dist":4,"deg":60},
///  {"seg":["A","B"]}, {"seg":["B","C"]}, {"seg":["A","C"]},
///  {"arc":["B","A","C"],"label":"60°"}]
/// ```
///
/// 作り直すときは `packages/figure` の `drawFigure` に上のJSONを渡す
/// (語彙は `docs/figeval/spec.md`)。
@widgetbook.UseCase(name: 'figure(作図。サーバが描いたSVG)', type: BoardElementView)
Widget buildFigureElementUseCase(BuildContext context) {
  return onBoard(
    const BoardElementView(
      element: BoardElement.figure(
        items: <Map<String, dynamic>>[],
        svg: _sampleFigureSvg,
        alt: '三角形ABC。角Aは60°、AB=6、AC=4',
      ),
    ),
  );
}

/// `@ai-sensei/figure` の出力そのまま。**手で書き換えない**
/// (先輩が書いたSVGが板書に入る経路は、どこにも無い)。
const String _sampleFigureSvg =
    '<svg viewBox="0 0 320 224" width="320" height="224" '
    'xmlns="http://www.w3.org/2000/svg" role="img">'
    '<rect width="320" height="224" fill="#2f3a35"/>'
    '<circle cx="26" cy="189.36" r="2.8" fill="#edeae0"/>'
    '<text x="26" y="182.36" fill="#edeae0" font-size="10" '
    'font-family="ZenMaruGothic" text-anchor="middle" font-weight="600">A</text>'
    '<circle cx="294" cy="189.36" r="2.8" fill="#edeae0"/>'
    '<text x="294" y="182.36" fill="#edeae0" font-size="10" '
    'font-family="ZenMaruGothic" text-anchor="middle" font-weight="600">B</text>'
    '<circle cx="115.33" cy="34.64" r="2.8" fill="#edeae0"/>'
    '<text x="115.33" y="27.64" fill="#edeae0" font-size="10" '
    'font-family="ZenMaruGothic" text-anchor="middle" font-weight="600">C</text>'
    '<line x1="26" y1="189.36" x2="294" y2="189.36" stroke="#edeae0" '
    'stroke-width="1.8" stroke-linecap="round"/>'
    '<line x1="294" y1="189.36" x2="115.33" y2="34.64" stroke="#edeae0" '
    'stroke-width="1.8" stroke-linecap="round"/>'
    '<line x1="26" y1="189.36" x2="115.33" y2="34.64" stroke="#edeae0" '
    'stroke-width="1.8" stroke-linecap="round"/>'
    '<path d="M 46 189.36 A 20 20 0 0 1 36 172.04" fill="none" stroke="#f2d675" '
    'stroke-width="1.4"/>'
    '<text x="53.71" y="176.36" fill="#f2d675" font-size="10" '
    'font-family="ZenMaruGothic" text-anchor="middle">60°</text>'
    '</svg>';
