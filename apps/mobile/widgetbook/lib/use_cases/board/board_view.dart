import 'package:ai_sensei/src/common_widgets/board_reveal.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 板書まるごと。**前の行は消さない**ので、手順を増やすと下に積まれる。
///
/// 板と左右の余白は [BoardView] が持っている。だからここでは横に余白を
/// 付けない(付けると二重になり、実効幅が340ptを割って式が横スクロールに落ちる)。
@widgetbook.UseCase(name: '手順を積む', type: BoardView)
Widget buildBoardViewUseCase(BuildContext context) {
  final int shown = context.knobs.int.slider(
    label: '積んだ手順の数',
    initialValue: 3,
    min: 1,
    max: 5,
    divisions: 4,
  );

  // 幅は端末の幅まで広げる(板書の実効幅が式の縮小率を決めるため)。
  // 縦は積むと画面を超えるので、スクロールに載せる。
  return SizedBox(
    width: double.infinity,
    child: SingleChildScrollView(
      child: BoardView(
        // 書かれていく動きを見たいので、手順の数が変わったら組み直す。
        key: ValueKey<int>(shown),
        steps: _lesson.take(shown).toList(),
      ),
    ),
  );
}

/// 板書が1行も無い授業(相づちだけの手順)。
///
/// [BoardView] は `board == null` の手順を落とすので、**板ごと消える**
/// (白い板に何も書かれていない状態にはならない)。
@widgetbook.UseCase(name: '板書がない(相づちだけ)', type: BoardView)
Widget buildBoardViewEmptyUseCase(BuildContext context) {
  return const Center(
    child: SizedBox(
      width: double.infinity,
      child: BoardView(
        steps: <BoardStep>[
          BoardStep(index: 0, speech: 'うんうん、それで?', board: null),
        ],
      ),
    ),
  );
}

/// 1行が書かれるところ。左から右へ、板書が現れる。
///
/// 「アニメーションを減らす」を入れると**書き終わった状態**で置かれる。
@widgetbook.UseCase(name: '1行が現れる', type: BoardReveal)
Widget buildBoardRevealUseCase(BuildContext context) {
  final int seed = context.knobs.int.slider(
    label: '再生し直す',
    initialValue: 0,
    min: 0,
    max: 5,
    divisions: 5,
  );

  return onBoard(
    BoardReveal(
      key: ValueKey<int>(seed),
      child: const BoardElementView(
        element: BoardElement.latex(tex: 'D = b^2 - 4ac'),
      ),
    ),
  );
}

/// 判別式の授業(`packages/contract/fixtures/board-lesson.json`)の頭のほう。
const List<BoardStep> _lesson = <BoardStep>[
  BoardStep(
    index: 0,
    speech: 'まず、式をそのまま書くね。',
    board: BoardElement.latex(tex: 'x^2 - 3x + 2 = 0'),
  ),
  BoardStep(
    index: 1,
    speech: 'a、b、c がどれか、言える?',
    board: BoardElement.text(body: 'a = 1, b = -3, c = 2'),
  ),
  BoardStep(
    index: 2,
    speech: '判別式は、この形だったよね。',
    board: BoardElement.latex(tex: 'D = b^2 - 4ac'),
  ),
  BoardStep(
    index: 3,
    speech: '入れてみると、どうなる?',
    board: BoardElement.latex(tex: r'D = (-3)^2 - 4 \cdot 1 \cdot 2 = 9 - 8 = 1'),
  ),
  BoardStep(
    index: 4,
    speech: 'Dが正だから、交点は2つ。',
    board: BoardElement.plot(
      fn: 'x^2 - 3*x + 2',
      domain: BoardDomain(min: -1, max: 4),
      marks: <PlotMark>[
        PlotMark(at: BoardPoint(x: 1, y: 0), label: 'x = 1'),
        PlotMark(at: BoardPoint(x: 2, y: 0), label: 'x = 2'),
      ],
    ),
  ),
];
