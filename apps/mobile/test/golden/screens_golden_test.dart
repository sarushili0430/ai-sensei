@Tags(<String>['golden'])
library;

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/settings/presentation/settings_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
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

  Future<void> capture(WidgetTester tester, String name) =>
      expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$name.png'));

  Future<void> expectGolden(
    WidgetTester tester,
    Widget screen,
    String name, {
    List<Object?> overrides = const <Object?>[],
  }) async {
    await setGoldenSurface(tester);
    await tester.pumpWidget(wrapApp(screen, overrides: overrides));
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

  // リハーサル。ここで見たいのは、**答えが1文字も出ていない**こと。
  // 出ているのは質問と、説明する/言えない の2つの道だけ。
  testWidgets('01b オンボーディング(リハーサル)', (WidgetTester tester) async {
    await setGoldenSurface(tester);
    await tester.pumpWidget(wrapApp(const OnboardingScreen()));
    await tester.pumpAndSettle();

    await tapNext(tester);
    await tapNext(tester);
    await capture(tester, 'onboarding_rehearsal');
  });

  // パスしたあとのカルテ見本。穴がピンクで残り、責める言葉が無く、
  // 「また来る」ことが線で見えているか。
  testWidgets('01c オンボーディング(カルテの見本)', (WidgetTester tester) async {
    await setGoldenSurface(tester);
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
    await expectGolden(
      tester,
      const HomeScreen(),
      'home',
      overrides: <Object?>[
        progressControllerProvider.overrideWith(FakeProgressController.new),
      ],
    );
  });

  // 初回起動のホーム。押すもののない空白にせず、次の一歩を出しているか。
  testWidgets('02b ホーム(初回起動)', (WidgetTester tester) async {
    await expectGolden(
      tester,
      const HomeScreen(),
      'home_first_run',
      overrides: <Object?>[
        progressControllerProvider.overrideWith(() => FakeProgressController(firstRunSummary)),
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

  // 「埋めにいく穴」と「埋めた穴」が同じ画面に並んでいるか。
  // 後者がペイウォールの謳う「履歴」で、別画面は作らない。
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
              filled: <FilledHole>[sampleFilledHole],
            ),
          ),
        ),
      ],
    );
  });

  // 無料ユーザー。「使えない」ではなく「まだ開いていない」として見えているか。
  // ホームへの出口が残っているかも、ここで見る。
  testWidgets('05b 復習(無料)', (WidgetTester tester) async {
    await expectGolden(
      tester,
      const ReviewScreen(),
      'review_locked',
      overrides: <Object?>[
        reviewControllerProvider.overrideWith(() => FakeReviewController(ReviewQueue.locked)),
      ],
    );
  });

  testWidgets('06 ペイウォール', (WidgetTester tester) async {
    await expectGolden(tester, const PaywallScreen(), 'paywall');
  });

  testWidgets('07 設定', (WidgetTester tester) async {
    await expectGolden(
      tester,
      const SettingsScreen(),
      'settings',
      overrides: <Object?>[
        deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
      ],
    );
  });
}
