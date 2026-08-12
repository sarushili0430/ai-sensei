import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_speech.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_style.dart';
import 'package:ai_sensei/src/features/session/presentation/board/figure_element_view.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';

/// 作図(`figure`)の端末側。
///
/// **端末は解かない。**SVGはサーバが検証済みの `items` から解いて描いたもので、
/// ここは表示するだけ(`docs/wireframe_board_v2.html` D-19/D-21)。
/// なのでここで見るのは「正しい図か」ではなく、
///   - 板書の1手順として収まる大きさか
///   - 読み上げが1つ付くか(`Math.tex` と同じ理由。§3-1)
///   - 壊れたものが来たときに画面ごと落ちないか
/// の3つ。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  /// サーバが返すのと同じ形の、小さなSVG。
  const String svg =
      '<svg viewBox="0 0 320 224" xmlns="http://www.w3.org/2000/svg">'
      '<rect width="320" height="224" fill="#2f3a35"/>'
      '<polygon points="30,190 290,190 160,40" fill="none" stroke="#edeae0" stroke-width="1.8"/>'
      '</svg>';

  const BoardElement element = BoardElement.figure(
    items: <Map<String, dynamic>>[
      <String, dynamic>{'pt': 'A', 'at': <double>[0, 4]},
    ],
    svg: svg,
    alt: '多角形(点 A・B・C)',
  );

  Widget host(BoardElement e) => MaterialApp(
        locale: const Locale('ja'),
        supportedLocales: AppStrings.supportedLocales,
        localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
          AppStringsDelegate(),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Scaffold(body: SizedBox(width: 340, child: BoardElementView(element: e))),
      );

  group('描画', () {
    testWidgets('SVGが描かれ、他のプリミティブと同じ高さに収まる', (WidgetTester tester) async {
      await tester.pumpWidget(host(element));
      await tester.pumpAndSettle();

      expect(find.byType(SvgPicture), findsOneWidget);
      expect(
        tester.getSize(find.byType(FigureElementView)).height,
        BoardStyle.graphicHeight,
      );
    });

    /// **幅いっぱいに引き伸ばさない。**SVGは文字も一緒に拡大縮小されるので、
    /// 横に伸ばすと縦も伸びて、板書の1手順として収まらなくなる。
    testWidgets('板書の実効幅(340pt)でも高さが増えない', (WidgetTester tester) async {
      await tester.pumpWidget(host(element));
      await tester.pumpAndSettle();
      expect(
        tester.getSize(find.byType(FigureElementView)).height,
        lessThanOrEqualTo(BoardStyle.graphicHeight),
      );
    });

    /// 壊れたSVGで**画面ごと落とさない**。板書の1行が抜けるほうが軽い
    /// (`board.ts` の「壊れたら止まる。ただし今あるものは消さない」と同じ判断)。
    testWidgets('壊れたSVGが来ても例外画面にしない', (WidgetTester tester) async {
      await tester.pumpWidget(
        host(
          const BoardElement.figure(
            items: <Map<String, dynamic>>[],
            svg: '<svg><this is not svg',
            alt: '図',
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('読み上げ', () {
    /// 図は `CustomPaint` と同じく**1文字も読まれない**ので、
    /// サーバが送ってきた `alt` をそのまま1つの文にする。
    test('alt をそのまま読む(端末側で組み立て直さない)', () {
      expect(describeElement(element, ja), '多角形(点 A・B・C)');
    });

    test('alt が無いときだけ定型に落ちる', () {
      const BoardElement noAlt = BoardElement.figure(
        items: <Map<String, dynamic>>[],
        svg: svg,
      );
      expect(describeElement(noAlt, ja), '図');
      expect(describeElement(noAlt, en), 'A figure');
    });

    testWidgets('読み上げは1つだけ付く(SVGの中身が別々に読まれない)', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(host(element));
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel('多角形(点 A・B・C)'), findsOneWidget);
      handle.dispose();
    });
  });

  group('契約', () {
    /// `svg` はワイヤーに出る時点で必ず入っている。無いまま描画へ渡すと
    /// 図の場所が**黙って空白**になるので、検査で落とす。
    test('svg の無い figure は契約違反', () {
      expect(() => ensureValidFigure(null), throwsA(isA<BoardContractViolation>()));
      expect(() => ensureValidFigure(''), throwsA(isA<BoardContractViolation>()));
      expect(() => ensureValidFigure(svg), returnsNormally);
    });

    test('サーバが返す形をそのままパースできる', () {
      final BoardElement parsed = BoardElement.fromJson(<String, dynamic>{
        'kind': 'figure',
        'items': <Map<String, dynamic>>[
          <String, dynamic>{'pt': 'A', 'at': <double>[0, 0]},
          <String, dynamic>{
            'seg': <String>['A', 'B'],
            'as': 'key',
          },
        ],
        'svg': svg,
        'alt': '多角形',
      });
      expect(parsed, isA<FigureElement>());
      expect((parsed as FigureElement).items, hasLength(2));
      expect(parsed.svg, svg);
    });
  });
}
