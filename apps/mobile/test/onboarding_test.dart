import 'package:ai_sensei/src/common_widgets/marker_text.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_rehearsal.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/latex_element_view.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// The onboarding rehearsal (page 3).
///
/// What is checked is not appearance but whether the promise holds as an
/// interaction:
///   - senpai teaches on the board, and one full round reaches teaching back
///   - passing still advances, and a pass is recorded as a gap
///   - the round completes without voice or photos (no permission asked first)
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  /// [pumpApp] pins the surface to a real device size.
  ///
  /// At the 800x600 default, the rehearsal page grown tall by the board pushes
  /// "I can't explain it" outside the viewport, and `tap` silently does nothing
  /// while the test still passes.
  Future<void> pumpOnboarding(
    WidgetTester tester, {
    Locale locale = const Locale('ja'),
    Size size = phoneSurface,
  }) => pumpApp(tester, const OnboardingScreen(), locale: locale, size: size);

  /// Advances to page [page] (0-based) via "next".
  Future<void> advanceTo(WidgetTester tester, int page, {AppStrings strings = ja}) async {
    for (int i = 0; i < page; i++) {
      await tester.tap(find.text(strings.onboardingNext));
      await tester.pumpAndSettle();
    }
  }

  /// Holds to teach back. The hold is interaction time, so disabling animation
  /// does not shorten it — hence advancing real time.
  Future<void> holdToExplain(WidgetTester tester) async {
    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(find.text(ja.onboardingTryHold)),
    );
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(AppDurations.hold + const Duration(milliseconds: 50));
    await gesture.up();
    await tester.pumpAndSettle();
  }

  testWidgets('1枚目は機能ではなく約束から始まる', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    expect(find.text(ja.onboardingTitle), findsOneWidget);
  });

  testWidgets('リハーサルは、まだ録音しないことを画面に書く', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    expect(find.text(ja.onboardingTryQuestion), findsOneWidget);
    expect(find.text(ja.onboardingTryNotRecording), findsOneWidget);
  });

  // The first half of the promise — teaching — must appear in the rehearsal too.
  // Reverting to listening without a board puts this page back on the old script.
  //
  // It also checks the production `BoardView` is used: swapping in a rebuilt
  // lookalike stops the rehearsal working as a preview of lesson mode.
  testWidgets('リハーサルは、聞く前に先輩が板書で教える', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    expect(find.text(ja.onboardingTryBoardLabel), findsOneWidget);

    final BoardView board = tester.widget<BoardView>(find.byType(BoardView));
    expect(board.steps.length, 2, reason: '板書は1〜2手順。ここが空だと「教える」が消える');
    expect(find.text(ja.onboardingTryBoardText), findsOneWidget);
    expect(find.byType(LatexElementView), findsOneWidget);
  });

  // This page exists to be done, not read. Controls missing from the initial
  // view matters more than a partly hidden board: the page gets swiped past
  // without anyone realising there is something to do. Grown tall by the board,
  // it breaks most easily on the narrowest device.
  for (final Locale locale in <Locale>[const Locale('ja'), const Locale('en')]) {
    final AppStrings s = AppStrings(locale);

    testWidgets('狭い端末でも操作が折り返しの上にある (${locale.languageCode})', (WidgetTester tester) async {
      await pumpOnboarding(tester, locale: locale, size: smallPhoneSurface);
      await advanceTo(tester, 2, strings: s);

      // Tappable without scrolling; inserting `ensureVisible` would void it.
      expect(tester.getRect(find.text(s.onboardingTryHold)).bottom, lessThan(smallPhoneSurface.height));
      expect(tester.getRect(find.text(s.sessionPass)).bottom, lessThan(smallPhoneSurface.height));

      await tester.tap(find.text(s.sessionPass));
      await tester.pumpAndSettle();
      expect(find.text(s.onboardingTryHoleReaction), findsOneWidget);
      expect(tester.getRect(find.text(s.onboardingTryAgain)).bottom, lessThan(smallPhoneSurface.height));
    });
  }

  // Cut off with no cue is the worst state (the vertical version of why
  // horizontal scrolling was rejected). Showing the cue when nothing is cut is a
  // lie, so both directions are checked.
  testWidgets('板書が切れる端末でだけ、下に続く手がかりを出す', (WidgetTester tester) async {
    await pumpOnboarding(tester, size: smallPhoneSurface);
    await advanceTo(tester, 2);
    expect(find.byKey(onboardingBoardMoreBelowKey), findsOneWidget);
  });

  testWidgets('板書が収まる端末では、手がかりを出さない', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);
    expect(find.byKey(onboardingBoardMoreBelowKey), findsNothing);
  });

  // The hold control and "next" sit one above the other, so which leads must be
  // clear. "Next" carries more visual weight (a filled chunky button), but it is
  // disabled until the teach-back, so only the control is colored. That is what
  // this pins.
  testWidgets('リハーサルを通るまで「つぎへ」は押せない', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    // Never a dead end: both pass and skip are present.
    expect(find.text(ja.sessionPass), findsOneWidget);
    expect(find.text(ja.onboardingSkip), findsOneWidget);

    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();
    expect(
      find.text(ja.onboardingTryQuestion),
      findsOneWidget,
      reason: '説明もパスもしていないうちは、リハーサルの枚に留まる',
    );
  });

  testWidgets('長押しして教え返すと、言えたこととして黄マーカーが残る', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);
    await holdToExplain(tester);

    expect(find.text(ja.onboardingTrySaidReaction), findsOneWidget);

    final MarkerText marker = tester.widget<MarkerText>(find.byType(MarkerText));
    expect(marker.marker, MarkerColor.said);
    expect(marker.text, ja.onboardingTrySaid);
  });

  // Passing is not failure; it becomes a gap, something to take away.
  testWidgets('うまく言えなくても進める。穴はピンクで残り、責める文言を出さない', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    await tester.tap(find.text(ja.sessionPass));
    await tester.pumpAndSettle();

    final MarkerText marker = tester.widget<MarkerText>(find.byType(MarkerText));
    expect(marker.marker, MarkerColor.hole);
    expect(find.text(ja.onboardingTryHoleReaction), findsOneWidget);

    // It still advances after a pass.
    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();
    expect(find.text(ja.onboardingKarteTitle), findsOneWidget);
  });

  testWidgets('カルテの見本は、リハーサルでやったことをそのまま出す', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);
    await holdToExplain(tester);

    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();

    // Someone who explained is never shown a gap they did not have.
    expect(find.text(ja.onboardingTrySaid), findsOneWidget);
    expect(find.text(ja.onboardingTryHole), findsNothing);
    expect(find.text(ja.onboardingCta), findsOneWidget);
  });

  // Reviewers see the English build, and long English in spacing designed for
  // Japanese overflows. All four pages are walked through.
  testWidgets('英語ロケールでも4枚とも組める', (WidgetTester tester) async {
    const AppStrings en = AppStrings(Locale('en'));
    await pumpOnboarding(tester, locale: const Locale('en'));

    await tester.tap(find.text(en.onboardingNext));
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.onboardingNext));
    await tester.pumpAndSettle();
    expect(find.text(en.onboardingTryQuestion), findsOneWidget);

    await tester.tap(find.text(en.sessionPass));
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.onboardingNext));
    await tester.pumpAndSettle();

    expect(find.text(en.onboardingKarteTitle), findsOneWidget);
    expect(find.text(en.onboardingReviewDay7), findsOneWidget);
  });

  testWidgets('やり直せる。選び直しても責めない', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    await tester.tap(find.text(ja.sessionPass));
    await tester.pumpAndSettle();

    await tester.tap(find.text(ja.onboardingTryAgain));
    await tester.pumpAndSettle();

    expect(find.text(ja.onboardingTryHold), findsOneWidget);
    expect(find.byType(MarkerText), findsNothing);
  });
}
