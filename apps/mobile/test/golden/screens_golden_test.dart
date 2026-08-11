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

import '../support/harness.dart';

/// 主要画面の golden test。
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
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(screen, overrides: overrides));
    await tester.pumpAndSettle();
    await capture(tester, name);
  }

  /// 常設タブ配下の画面を、本番と同じルータ込みで撮る。
  ///
  /// 画面だけを `MaterialApp.home` に置くと、下部ナビゲーションが丸ごと
  /// テスト対象から抜ける。ホームの高さがタブぶん縮んで操作が押し出される壊れ方も
  /// 見えなくなるので、シェル配下の既存goldenだけはこちらを通す。
  Future<void> expectRoutedGolden(
    WidgetTester tester,
    String location,
    String name, {
    ProgressSummary progress = firstRunSummary,
    ReviewQueue reviews = const ReviewQueue(items: <ReviewQueueItem>[]),
    List<Object?> overrides = const <Object?>[],
  }) async {
    await setSurface(tester);
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
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

  // リハーサル。ここで見たいのは、**答えが1文字も出ていない**こと。
  // 出ているのは質問と、説明する/言えない の2つの道だけ。
  testWidgets('01b オンボーディング(リハーサル)', (WidgetTester tester) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(const OnboardingScreen()));
    await tester.pumpAndSettle();

    await tapNext(tester);
    await tapNext(tester);
    await capture(tester, 'onboarding_rehearsal');
  });

  // パスしたあとのカルテ見本。穴がピンクで残り、責める言葉が無く、
  // 「また来る」ことが線で見えているか。
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

  // 初回起動のホーム。押すもののない空白にせず、次の一歩を出しているか。
  testWidgets('02b ホーム(初回起動)', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.home.path,
      'home_first_run',
      progress: firstRunSummary,
    );
  });

  // 契約している人のホーム。右上に印が出ているか、
  // それが数えている2つ(連続日数・埋めた穴)を押し出していないか。
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

  // 「埋めにいく穴」と「埋めた穴」が同じ画面に並んでいるか。
  // 後者がペイウォールの謳う「履歴」で、別画面は作らない。
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

  // 購入のお礼。見たいのは、祝っている画面でも
  // **更新日と解約できることが消えていない**こと(Guideline 3.1.2)。
  //
  // 無料トライアルの見出しは残り日数で変わる = 撮る日で変わるので、
  // golden では撮らない(文言の出し分けは monetization_test.dart で見る)。
  testWidgets('08 購入のお礼', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.thanks.path,
      'thanks',
      overrides: premiumOverrides(),
    );
  });
}
