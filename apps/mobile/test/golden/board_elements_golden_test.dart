@Tags(<String>['golden'])
library;

import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_style.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// Golden tests per board element.
///
/// Where `screens_golden_test.dart` works per screen, this works per element,
/// checking only that each `BoardElement` renders readably. Neither
/// `BoardChannelReceiver` nor LiveKit is involved; all data is built inline.
///
/// As in `test/golden/README.md`, CI (Linux) is authoritative for generation and
/// PNGs shot locally on macOS are not committed.
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
        // Shot on the board. Elements always sit inside [BoardView], which owns
        // the surface, so shooting them on the page background would bake in a
        // look the app never shows — and chalk colors are unreadable on white.
        ColoredBox(
          color: BoardStyle.surface,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: BoardElementView(element: element),
          ),
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

  // The English board. It shares no branch with maths, so visual regressions are
  // caught only here: the `focus` underline and the comparison's even columns.
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

  // A deliberately over-long formula below the 70% floor, checking the fallback
  // (pinned scale plus horizontal scrolling).
  testWidgets('latex要素(実効幅を大きく超える。70%フロアのフォールバック)', (WidgetTester tester) async {
    await expectElementGolden(
      tester,
      const BoardElement.latex(
        tex: r'(x+1)(x+2)(x+3)(x+4) = x^4 + 10x^3 + 35x^2 + 50x + 24',
      ),
      'latex_overflow_floor',
    );
  });

  // The final state after three steps. The subject is the end state, not the
  // timing. It mirrors the first three steps of the discriminant lesson in the
  // board-lesson.json fixture.
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
      // Padding only outside the board. [BoardView] owns the surface and inner
      // padding, so another layer here would eat the effective width twice.
      wrapApp(
        const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: BoardView(steps: steps)),
      ),
    );
    await tester.pumpAndSettle();
    await capture(tester, 'stacked_3steps');
  });
}
