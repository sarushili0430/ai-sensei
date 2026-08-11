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

/// カルテに残る板書(ADR 0006)。
///
/// - 見るのは「残っているか」「とぎれていると分かるか」「幅が痩せていないか」
/// - golden は置かない(比較対象のPNGはCI/Linuxで作る)
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  const BoardStep sampleStep = BoardStep(
    index: 0,
    speech: 'ここ、Dを見てほしいんだけど',
    // 数式ではなく text にしてあるのは、フォントを読み込まない widget test で
    // LaTeX が tofu になっても意味のある検証にならないため(計画書§3-6c)。
    board: BoardElement.text(body: '解が2つ ⇔ D > 0'),
  );

  /// 板書を手元に置いた状態を作る。見るのは書き込み口ではなく見せ方。
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

  // 音声だけで終わった会話や、授業が1回も無い状態。空の見出しだけが残ると、
  // 何も起きていないのに壊れて見える。
  testWidgets('板書が無ければ、見出しごと出さない', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const KarteScreen(),
      overrides: overridesWith(LastBoard.empty),
    );

    expect(find.text(ja.karteBoardTitle), findsNothing);
    expect(find.byType(BoardView), findsNothing);
  });

  // 配送が欠落した板書は、手順の列だけ見ても健全なものと区別がつかない。
  // 黙って出すと、計画書§3-6b が横スクロールを却下した理由
  // 「これで全部だ」と誤読させる — をそのまま再現する。
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

  /// 板書の実効幅は授業モードと同じでなければならない。
  /// カードに入れると 345pt → 311pt へ落ち、収まる式が横スクロールになる。
  /// 落ちたことは `debugPrint` にしか出ないので、幅で見張る。
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
