import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// 主要画面の golden test(handoff §5)。
///
/// 見ているのは「崩れていないか」よりも **設計上の約束が画面に出ているか**:
/// 点数が出ていないか、穴がピンクのマーカーで示されているか、
/// ペイウォールに無料継続の導線が残っているか。
///
/// 生成はCI(Linux)を正とする:
///   flutter test --update-goldens
/// 端末やOSが違うとフォントラスタライズが変わるので、手元の差分はコミットしない。
void main() {
  setUpAll(loadAppFonts);

  Future<void> expectGolden(
    WidgetTester tester,
    Widget screen,
    String name, {
    List<Object?> overrides = const <Object?>[],
  }) async {
    await setGoldenSurface(tester);
    await tester.pumpWidget(wrapApp(screen, overrides: overrides));
    await tester.pumpAndSettle();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$name.png'));
  }

  testWidgets('01 オンボーディング', (WidgetTester tester) async {
    await expectGolden(tester, const OnboardingScreen(), 'onboarding');
  });

  testWidgets('02 ホーム', (WidgetTester tester) async {
    await expectGolden(
      tester,
      const HomeScreen(),
      'home',
      overrides: <Object?>[
        progressControllerProvider.overrideWith(FakeProgressController.new),
      ],
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
    await expectGolden(
      tester,
      const KarteScreen(),
      'karte',
      overrides: <Object?>[
        latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
        sessionOutcomeControllerProvider.overrideWith(
          () => FakeSessionOutcomeController(const SessionOutcome(showPaywall: true)),
        ),
      ],
    );
  });

  testWidgets('05 復習(Premium)', (WidgetTester tester) async {
    await expectGolden(
      tester,
      const ReviewScreen(),
      'review',
      overrides: <Object?>[
        reviewControllerProvider.overrideWith(
          () => FakeReviewController(
            ReviewQueue(
              requiresPremium: false,
              items: <ReviewQueueItem>[
                ReviewQueueItem(
                  hole: sampleKarte.holes.first,
                  daysSince: 3,
                  prompt: '3日前の「判別式のなぜ」、いまなら説明できますか?',
                ),
              ],
            ),
          ),
        ),
      ],
    );
  });

  testWidgets('06 ペイウォール', (WidgetTester tester) async {
    await expectGolden(tester, const PaywallScreen(), 'paywall');
  });
}
