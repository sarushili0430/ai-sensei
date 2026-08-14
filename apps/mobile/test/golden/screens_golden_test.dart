@Tags(<String>['golden'])
library;

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/routing/routes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/harness.dart';

/// Golden tests for the main screens.
///
/// They check less that nothing is broken than that the design promises appear
/// on screen: no scores, gaps marked with a pink highlighter, and the paywall
/// still offering a way to stay free.
///
/// CI (Linux) is authoritative for generation:
///   flutter test --update-goldens
/// Font rasterization differs by device and OS, so local diffs are not committed.
void main() {
  setUpAll(loadAppFonts);

  Future<void> capture(WidgetTester tester, String name) =>
      expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$name.png'));

  Future<void> expectGolden(
    WidgetTester tester,
    Widget screen,
    String name, {
    List<Object?> overrides = const <Object?>[],
  }) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(screen, overrides: overrides));
    await tester.pumpAndSettle();
    await capture(tester, name);
  }

  /// Shoots screens under the permanent tabs with the production router.
  ///
  /// Putting a screen alone in `MaterialApp.home` drops the bottom navigation
  /// from the test entirely, hiding the break where home shrinks by the tab
  /// height and pushes controls out. So goldens under the shell take this path.
  Future<void> expectRoutedGolden(
    WidgetTester tester,
    String location,
    String name, {
    ProgressSummary progress = firstRunSummary,
    ReviewQueue reviews = const ReviewQueue(items: <ReviewQueueItem>[]),
    List<Object?> overrides = const <Object?>[],
  }) async {
    await setSurface(tester);
    // Settings reads the school stage. `preferencesProvider` is meant to be
    // overridden in main(), so without it here the settings golden crashes.
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        preferencesProvider.overrideWithValue(preferences),
        onboardedProvider.overrideWithValue(true),
        deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
        progressControllerProvider.overrideWith(() => FakeProgressController(progress)),
        reviewControllerProvider.overrideWith(() => FakeReviewController(reviews)),
        ...overrides,
      ].cast(),
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(wrapRouter(container));
    await tester.pumpAndSettle();
    container.read(appRouterProvider).go(location);
    await tester.pumpAndSettle();
    await capture(tester, name);
  }

  const AppStrings ja = AppStrings(Locale('ja'));

  Future<void> tapNext(WidgetTester tester) async {
    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();
  }

  testWidgets('01 オンボーディング(約束)', (WidgetTester tester) async {
    await expectGolden(tester, const OnboardingScreen(), 'onboarding');
  });

  // The rehearsal. What matters here is that not one character of the answer is
  // shown: only the question and the two paths (explain / can't say it).
  testWidgets('01b オンボーディング(リハーサル)', (WidgetTester tester) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(const OnboardingScreen()));
    await tester.pumpAndSettle();

    await tapNext(tester);
    await tapNext(tester);
    await capture(tester, 'onboarding_rehearsal');
  });

  // The sample karte after a pass: the gap stays pink, no blaming wording, and
  // the return visits are visible as a line.
  testWidgets('01c オンボーディング(カルテの見本)', (WidgetTester tester) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(const OnboardingScreen()));
    await tester.pumpAndSettle();

    await tapNext(tester);
    await tapNext(tester);
    await tester.tap(find.text(ja.sessionPass));
    await tester.pumpAndSettle();
    await tapNext(tester);
    await capture(tester, 'onboarding_karte');
  });

  testWidgets('02 ホーム', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.home.path,
      'home',
      progress: sampleSummary,
      reviews: sampleReviewQueue,
    );
  });

  // Home on first launch: not a blank with nothing to press, but a next step.
  testWidgets('02b ホーム(初回起動)', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.home.path,
      'home_first_run',
      progress: firstRunSummary,
    );
  });

  // Home for a subscriber: the marker appears top right without pushing out the
  // two counters (streak days, filled gaps).
  testWidgets('02c ホーム(Premium)', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.home.path,
      'home_premium',
      progress: premiumSummary,
      reviews: sampleReviewQueue,
      overrides: premiumOverrides(),
    );
  });

  testWidgets('03 祝福', (WidgetTester tester) async {
    await expectGolden(
      tester,
      const CelebrationScreen(),
      'celebration',
      overrides: <Object?>[
        progressControllerProvider.overrideWith(FakeProgressController.new),
        latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
        sessionOutcomeControllerProvider.overrideWith(
          () => FakeSessionOutcomeController(const SessionOutcome()),
        ),
      ],
    );
  });

  testWidgets('04 カルテ', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.karte.path,
      'karte',
      overrides: <Object?>[
        latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
        sessionOutcomeControllerProvider.overrideWith(
          () => FakeSessionOutcomeController(const SessionOutcome(showPaywall: true)),
        ),
      ],
    );
  });

  // Gaps to fill and filled gaps sit on the same screen. The latter is the
  // "history" the paywall advertises, and gets no screen of its own.
  testWidgets('05 復習(Premium)', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.review.path,
      'review',
      progress: premiumSummary,
      reviews: ReviewQueue(
        items: <ReviewQueueItem>[
          ReviewQueueItem(
            hole: sampleKarte.holes.first,
            daysSince: 3,
            prompt: '3日前の「判別式のなぜ」、いまなら説明できますか?',
            quiz: '判別式を使うと解の個数がわかる理由を説明できる?',
          ),
        ],
        filled: <FilledHole>[sampleFilledHole],
      ),
    );
  });

  testWidgets('06 ペイウォール', (WidgetTester tester) async {
    await expectRoutedGolden(tester, AppRoute.paywall.path, 'paywall');
  });

  testWidgets('07 設定', (WidgetTester tester) async {
    await expectRoutedGolden(tester, AppRoute.settings.path, 'settings');
  });

  // The thank-you screen: even while celebrating, the renewal date and the
  // ability to cancel must not disappear (guideline 3.1.2).
  //
  // The trial heading varies with days remaining, so it changes with the shoot
  // date and is not captured here (monetization_test.dart covers the wording).
  testWidgets('08 購入のお礼', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.thanks.path,
      'thanks',
      overrides: premiumOverrides(),
    );
  });
}
