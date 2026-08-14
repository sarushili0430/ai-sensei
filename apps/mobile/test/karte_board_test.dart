import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/application/last_board_controller.dart';
import 'package:ai_sensei/src/features/karte/domain/last_board.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// The board kept in the karte (ADR 0006).
///
/// - It checks that it survives, that truncation is visible, and that the width
///   is not eaten
/// - No goldens here (reference PNGs are produced on CI/Linux)
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  const BoardStep sampleStep = BoardStep(
    index: 0,
    speech: 'ここ、Dを見てほしいんだけど',
    // Text rather than a formula: in a widget test without fonts loaded, LaTeX
    // renders as tofu and the check would be meaningless.
    board: BoardElement.text(body: '解が2つ ⇔ D > 0'),
  );

  /// Puts a board in place. What is checked is presentation, not the writer.
  List<Object?> overridesWith(LastBoard board) => <Object?>[
        latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
        lastBoardControllerProvider.overrideWith(() => _FakeLastBoardController(board)),
      ];

  testWidgets('さっきの板書が、カルテに残っている', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const KarteScreen(),
      overrides: overridesWith(const LastBoard(steps: <BoardStep>[sampleStep])),
    );

    expect(find.text(ja.karteBoardTitle), findsOneWidget);
    expect(find.byType(BoardView), findsOneWidget);
    expect(find.text('解が2つ ⇔ D > 0'), findsOneWidget);
    expect(find.text(ja.karteBoardTruncated), findsNothing);
  });

  // A voice-only conversation, or no lesson at all. An empty heading alone looks
  // broken even though nothing went wrong.
  testWidgets('板書が無ければ、見出しごと出さない', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const KarteScreen(),
      overrides: overridesWith(LastBoard.empty),
    );

    expect(find.text(ja.karteBoardTitle), findsNothing);
    expect(find.byType(BoardView), findsNothing);
  });

  // A board with a delivery gap is indistinguishable from a healthy one by its
  // step list alone. Showing it silently reproduces exactly the problem that got
  // horizontal scrolling rejected: being misread as "that's all".
  testWidgets('とぎれた板書は、とぎれていると分かる', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const KarteScreen(),
      overrides: overridesWith(
        const LastBoard(steps: <BoardStep>[sampleStep], truncated: true),
      ),
    );

    expect(find.text('解が2つ ⇔ D > 0'), findsOneWidget, reason: '書かれた行は消さない');
    expect(find.text(ja.karteBoardTruncated), findsOneWidget);
  });

  testWidgets('空の板書には、とぎれた印を出さない', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const KarteScreen(),
      overrides: overridesWith(const LastBoard(truncated: true)),
    );

    expect(find.text(ja.karteBoardTruncated), findsNothing);
  });

  /// The board's effective width must match lesson mode. In a card it drops from
  /// 345pt to 311pt and formulas that fit start scrolling horizontally. That only
  /// reaches `debugPrint`, so the width itself is watched.
  testWidgets('板書の実効幅は、実測の前提(340pt)を下回らない', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const KarteScreen(),
      overrides: overridesWith(const LastBoard(steps: <BoardStep>[sampleStep])),
    );

    expect(tester.getSize(find.byType(BoardView)).width, greaterThanOrEqualTo(340));
  });
}

class _FakeLastBoardController extends LastBoardController {
  _FakeLastBoardController(this._board);

  final LastBoard _board;

  @override
  LastBoard build() => _board;
}
