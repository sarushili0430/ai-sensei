@Tags(<String>['golden'])
library;

import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// 板書の要素ごとの golden test。
///
/// `screens_golden_test.dart` が画面単位なのに対し、こちらは要素単位。
/// 「1つ1つの `BoardElement` が読める形で描けているか」だけを見る
/// (`BoardChannelReceiver` やLiveKitは絡めない。渡すデータは全部その場で作る)。
///
/// 生成はCI(Linux)を正とする方針は `test/golden/README.md` と同じ。
/// 手元(macOS)で撮ったPNGはコミットしない。
void main() {
  setUpAll(loadAppFonts);

  Future<void> capture(WidgetTester tester, String name) =>
      expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/board_$name.png'));

  Future<void> expectElementGolden(
    WidgetTester tester,
    BoardElement element,
    String name,
  ) async {
    await setSurface(tester, size: const Size(360, 220));
    await tester.pumpWidget(
      wrapApp(
        Padding(
          padding: const EdgeInsets.all(16),
          child: BoardElementView(element: element),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await capture(tester, name);
  }

  testWidgets('latex要素(判別式。board-lesson.jsonのfixtureと同じ式)', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.latex(tex: r'D = (-3)^2 - 4 \cdot 1 \cdot 2 = 9 - 8 = 1'),
      'latex',
    );
  });

  testWidgets('text要素', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.text(body: 'a = 1, b = -3, c = 2'),
      'text',
    );
  });

  testWidgets('plot要素(board-lesson.en.jsonのfixtureと同じ関数・印)', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.plot(
        fn: 'x^2 - 3*x + 2',
        domain: BoardDomain(min: -1, max: 4),
        marks: <PlotMark>[
          PlotMark(at: BoardPoint(x: 1, y: 0), label: 'x = 1'),
          PlotMark(at: BoardPoint(x: 2, y: 0), label: 'x = 2'),
        ],
      ),
      'plot',
    );
  });

  testWidgets('triangle要素(頂点名・直角マーク・角のマーク)', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.triangle(
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
      'triangle',
    );
  });

  testWidgets('circle要素(board-channel-log.jsonのfixtureと同じ円)', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.circle(
        center: BoardPoint(x: 0, y: 0),
        r: 5,
        labels: <String>['O', 'r = 5'],
      ),
      'circle',
    );
  });

  // 英語の板書。**数学とは1枝も重ならない**ので、見た目の回帰はここでしか捕まらない。
  // `focus` の下線が引かれているか、対比表の2列が等分されているかを見る。
  testWidgets('sentence要素(focus に下線。board-lesson.english.json と同じ文)', (
    WidgetTester tester,
  ) async {
    await expectElementGolden(
      tester,
      const BoardElement.sentence(
        text: 'I have lived here for ten years.',
        gloss: '10年間ここに住んでいる(今も)',
        focus: 'have lived',
      ),
      'sentence',
    );
  });

  testWidgets('compare要素(2列の対比表)', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.compare(
        title: '現在完了 と 過去形',
        columns: <String>['現在完了', '過去形'],
        rows: <List<String>>[
          <String>['have + 過去分詞', '過去形'],
          <String>['今とつながっている', '今のことは言っていない'],
        ],
      ),
      'compare',
    );
  });

  // 縮小率70%を下回る、意図的に長すぎる式。フォールバック(横スクロール固定)を確認する。
  testWidgets('latex要素(実効幅を大きく超える。70%フロアのフォールバック)', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.latex(
        tex: r'(x+1)(x+2)(x+3)(x+4) = x^4 + 10x^3 + 35x^2 + 50x + 24',
      ),
      'latex_overflow_floor',
    );
  });

  // 「3手順積んだ最終状態」。タイミングではなく最終状態を検証対象にする
  // (team-leadの指定どおり)。判別式の授業(board-lesson.jsonのfixture)の
  // 最初の3手順を模している。
  testWidgets('3手順積んだ最終状態(latex→text→latex)', (WidgetTester tester) async {
    const List<BoardStep> steps = <BoardStep>[
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
    ];

    await setSurface(tester, size: const Size(393, 500));
    await tester.pumpWidget(
      wrapApp(const Padding(padding: EdgeInsets.all(16), child: BoardView(steps: steps))),
    );
    await tester.pumpAndSettle();
    await capture(tester, 'stacked_3steps');
  });
}
