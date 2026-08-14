import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_speech.dart';
import 'package:ai_sensei/src/features/session/presentation/board/figure_element_view.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';

/// The device side of constructions (`figure`).
///
/// The device does not solve anything: the SVG was solved and drawn on the
/// server from validated `items`, and this only displays it. So what is checked
/// is not whether the figure is correct but:
///   - whether it fits as one board step
///   - whether it gets one narration (same reason as `Math.tex`)
///   - whether malformed input takes the screen down
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  /// A small SVG in the same shape the server returns.
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
    /// Match the width of formulas and notes.
    ///
    /// It used to match the other primitives' height and centre at its own ratio,
    /// so it sat in a box narrower than the board's effective width. Formulas run
    /// full width from the left, so the figure alone looked inset (raised on
    /// device).
    testWidgets('SVGが描かれ、板書の幅いっぱいに広がる', (WidgetTester tester) async {
      await tester.pumpWidget(host(element));
      await tester.pumpAndSettle();

      expect(find.byType(SvgPicture), findsOneWidget);
      expect(tester.getSize(find.byType(FigureElementView)).width, 340);
    });

    /// Matching the width stretches the height by the ratio, with a cap so one
    /// step cannot fill the screen — the board stacks, and an oversized step
    /// pushes earlier lines out.
    testWidgets('縦は比率のまま伸び、上限を超えない', (WidgetTester tester) async {
      await tester.pumpWidget(host(element));
      await tester.pumpAndSettle();

      final double height = tester.getSize(find.byType(FigureElementView)).height;
      // A 320x224 figure at 340pt is 238pt; the ratio is preserved.
      expect(height, closeTo(340 * 224 / 320, 1));
      expect(height, lessThanOrEqualTo(FigureElementView.maxHeight));
    });

    /// Even a tall figure must not fill the screen in one step.
    testWidgets('縦長のSVGは上限で止める', (WidgetTester tester) async {
      await tester.pumpWidget(
        host(
          const BoardElement.figure(
            items: <Map<String, dynamic>>[],
            svg: '<svg viewBox="0 0 100 400" xmlns="http://www.w3.org/2000/svg">'
                '<rect width="100" height="400" fill="#2f3a35"/></svg>',
            alt: '数直線',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        tester.getSize(find.byType(FigureElementView)).height,
        FigureElementView.maxHeight,
      );
    });

    /// A malformed SVG must not take the screen down; losing one board line costs
    /// less (the same call as "stop on breakage, never erase").
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
    /// Like `CustomPaint`, a figure is not read at all, so the `alt` the server
    /// sent becomes the single sentence, unchanged.
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
    /// `svg` is always present by the time it reaches the wire. Passing one
    /// without it leaves the figure's place silently blank, so validation rejects
    /// it.
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
