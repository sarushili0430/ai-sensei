import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/thanks_screen.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/settings/presentation/settings_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// Whether content overflows the screen on a narrow device.
///
/// The same break happened three times: a `Column` pushed to the bottom with a
/// `Spacer` clips its children the moment the copy grows, leaving controls
/// unreachable. And `RenderFlex overflowed` only paints stripes — the test stays
/// green (and without a pinned surface size it does not reproduce at all).
///
///   - onboarding pages 1 and 2 … English headings overflowed 145px at 375x667
///   - the rehearsal … the board pushed controls below the fold
///   - capture confirmation … the contract's 600-character problem overflowed
///     557px
///
/// The trigger is always the same: the narrowest device with the longest copy.
/// So every screen is rendered once under those conditions and only checked for
/// the absence of an exception. Appearance is the goldens' job; this checks only
/// that nothing is clipped.
void main() {
  /// Renders [screen] on a narrow device and checks nothing overflows.
  ///
  /// `RenderFlex overflowed` surfaces as a `FlutterError`, so `takeException()`
  /// catches it.
  Future<void> expectNoOverflow(
    WidgetTester tester,
    Widget screen, {
    required Locale locale,
    List<Object?> overrides = const <Object?>[],
  }) async {
    await pumpApp(
      tester,
      screen,
      overrides: overrides,
      locale: locale,
      size: smallPhoneSurface,
    );
    expect(
      tester.takeException(),
      isNull,
      reason: '${screen.runtimeType} が ${locale.languageCode} で '
          '${smallPhoneSurface.width.toInt()}x${smallPhoneSurface.height.toInt()} から溢れています',
    );
  }

  // English runs 1.5-2x longer than Japanese, so spacing designed for Japanese
  // always breaks in English. Both are covered (reviewers see the English build).
  for (final Locale locale in <Locale>[const Locale('ja'), const Locale('en')]) {
    final String lang = locale.languageCode;

    testWidgets('オンボーディング4枚 ($lang)', (WidgetTester tester) async {
      final AppStrings strings = AppStrings(locale);
      await pumpApp(
        tester,
        const OnboardingScreen(),
        locale: locale,
        size: smallPhoneSurface,
      );
      expect(tester.takeException(), isNull, reason: '1枚目');

      for (final String page in <String>['2枚目', '3枚目']) {
        await tester.tap(find.text(strings.onboardingNext));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: page);
      }

      // Page 4 requires passing through page 3; a pass gets there too.
      await tester.tap(find.text(strings.sessionPass));
      await tester.pumpAndSettle();
      await tester.tap(find.text(strings.onboardingNext));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: '4枚目');
    });

    testWidgets('ホーム ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const HomeScreen(),
        locale: locale,
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
        ],
      );
    });

    // Home on a day the limit was hit. Senpai's judgement runs long, so this
    // grows most easily.
    testWidgets('ホーム(今日はここまで) ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const HomeScreen(),
        locale: locale,
        overrides: <Object?>[
          progressControllerProvider.overrideWith(
            () => FakeProgressController(exhaustedSummary),
          ),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
        ],
      );
    });

    testWidgets('祝福 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const CelebrationScreen(),
        locale: locale,
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(const SessionOutcome()),
          ),
        ],
      );
    });

    testWidgets('カルテ ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const KarteScreen(),
        locale: locale,
        overrides: <Object?>[
          latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(const SessionOutcome(showPaywall: true)),
          ),
        ],
      );
    });

    testWidgets('復習 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const ReviewScreen(),
        locale: locale,
        overrides: <Object?>[
          reviewControllerProvider.overrideWith(
            () => FakeReviewController(
              ReviewQueue(
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
            ),
          ),
        ],
      );
    });

    testWidgets('ペイウォール ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(tester, const PaywallScreen(), locale: locale);
    });

    testWidgets('購入のお礼 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const ThanksScreen(),
        locale: locale,
        overrides: premiumOverrides(),
      );
    });

    testWidgets('設定 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const SettingsScreen(),
        locale: locale,
        overrides: <Object?>[
          deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
        ],
      );
    });
  }
}
