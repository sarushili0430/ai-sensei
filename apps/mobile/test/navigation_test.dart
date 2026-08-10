import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/thanks_screen.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/settings/presentation/settings_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/routing/routes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'support/harness.dart';

/// 導線のテスト。
///
/// 見ているのは見た目ではなく **どの画面からも出られるか**。
/// 実装当初はすべての遷移が `context.go()` で、スタックの深さが常に1だった。
/// その結果どの画面にも戻るボタンが出ず、復習画面が行き止まりになっていた。
/// ここが落ちたら、また同じ形に戻っている。
void main() {
  /// 起動時に確定する値。本番は main() が差し込む。
  Future<List<Object?>> bootOverrides({
    bool onboarded = true,
    bool premium = false,
    ReviewQueue? queue,
    Karte? karte,
  }) async {
    return <Object?>[
      onboardedProvider.overrideWithValue(onboarded),
      deviceIdProvider.overrideWithValue('dev_test'),
      // 設定画面が言語の設定を読む。
      await preferencesOverride(),
      progressControllerProvider.overrideWith(FakeProgressController.new),
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(queue ?? const ReviewQueue(items: [], requiresPremium: false)),
      ),
      if (karte != null)
        latestKarteControllerProvider.overrideWith(() => FakeLatestKarteController(karte)),
      if (premium) ...premiumOverrides(),
    ];
  }

  Future<GoRouter> pumpRouter(
    WidgetTester tester, {
    List<Object?> overrides = const <Object?>[],
  }) async {
    final ProviderContainer container = ProviderContainer(overrides: overrides.cast());
    addTearDown(container.dispose);

    await tester.pumpWidget(wrapRouter(container));
    await tester.pumpAndSettle();
    return container.read(appRouterProvider);
  }

  testWidgets('初回起動はオンボーディングから始まる', (WidgetTester tester) async {
    await pumpRouter(tester, overrides: await bootOverrides(onboarded: false));
    expect(find.byType(OnboardingScreen), findsOneWidget);
  });

  testWidgets('通過済みならホームから始まる', (WidgetTester tester) async {
    await pumpRouter(tester, overrides: await bootOverrides());
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('ホーム → 設定 は戻れる', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: await bootOverrides());

    await tester.tap(find.byIcon(Icons.settings_outlined));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget);

    expect(router.canPop(), isTrue, reason: '設定は寄り道なので、戻れなければならない');
    router.pop();
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('通知から復習画面へ直接着地しても、下にホームが積まれている', (WidgetTester tester) async {
    // コールドスタートで go('/review') される経路。push ではないので、
    // ルートを入れ子にしていないとスタックの深さが1になり行き止まりになる。
    final GoRouter router = await pumpRouter(tester, overrides: await bootOverrides());

    router.go(AppRoute.review.path);
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget);

    expect(router.canPop(), isTrue, reason: '通知から来ても、ホームへ戻れなければならない');
    router.pop();
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('復習画面は、穴がひとつも無くても出口がある', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: await bootOverrides());
    router.go(AppRoute.review.path);
    await tester.pumpAndSettle();

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(ReviewScreen)),
    );
    await tester.tap(find.text(strings.reviewBackHome));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('無料ユーザーの復習画面からペイウォールに行き、戻ってこられる', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(
      tester,
      overrides: await bootOverrides(queue: ReviewQueue.locked),
    );
    router.go(AppRoute.review.path);
    await tester.pumpAndSettle();

    final AppStrings strings = AppStrings.of(tester.element(find.byType(ReviewScreen)));
    expect(find.text(strings.reviewLocked), findsOneWidget);

    await tester.tap(find.text(strings.paywallCta));
    await tester.pumpAndSettle();
    expect(router.canPop(), isTrue, reason: 'ペイウォールは閉じられなければならない');

    router.pop();
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget, reason: '来た場所に戻す');
  });

  testWidgets('直近のカルテが無いのにカルテ画面へ行くと、ホームへ戻す', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: await bootOverrides());

    router.go(AppRoute.karte.path);
    await tester.pumpAndSettle();

    expect(find.byType(KarteScreen), findsNothing);
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('直近のカルテがあればカルテ画面を出す', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(
      tester,
      overrides: await bootOverrides(karte: sampleKarte),
    );

    router.go(AppRoute.karte.path);
    await tester.pumpAndSettle();
    expect(find.byType(KarteScreen), findsOneWidget);
  });

  // 決済は通ったのに entitlement が付いていない(ダッシュボードの設定漏れ)と、
  // ここへ来る。紙吹雪を見せてから使えないのが、いちばん落差が大きい。
  testWidgets('契約が無いのにお礼へ行くと、ホームへ戻す', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides());

    router.go(thanksLocation());
    await tester.pumpAndSettle();

    expect(find.byType(ThanksScreen), findsNothing);
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('契約していればお礼を出し、はじめるでホームへ戻る', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides(premium: true));

    router.go(thanksLocation());
    await tester.pumpAndSettle();
    expect(find.byType(ThanksScreen), findsOneWidget);

    final AppStrings strings = AppStrings.of(tester.element(find.byType(ThanksScreen)));
    await tester.tap(find.text(strings.thanksStart));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  // 買ったあとにペイウォールへ戻れても、戻る先は「もう一度買う画面」しかない。
  testWidgets('お礼はペイウォールを差し替える(閉じても買う画面に戻らない)', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides(premium: true));

    router.push(AppRoute.paywall.path);
    await tester.pumpAndSettle();
    expect(find.byType(PaywallScreen), findsOneWidget);

    // 購入が通ったところ。SDKを呼ばずに、画面が呼ぶのと同じ導線だけ動かす。
    tester.element(find.byType(PaywallScreen)).replaceWithThanks();
    await tester.pumpAndSettle();
    expect(find.byType(ThanksScreen), findsOneWidget);

    final AppStrings strings = AppStrings.of(tester.element(find.byType(ThanksScreen)));
    await tester.tap(find.text(strings.thanksStart));
    await tester.pumpAndSettle();

    expect(find.byType(PaywallScreen), findsNothing, reason: 'ペイウォールは残っていてはいけない');
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  // 機種変更で戻ってきた人。「おかえりなさい」を出したあと、設定に戻す。
  testWidgets('設定からの復元は、お礼を重ねて出して設定に戻る', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides(premium: true));

    router.push(AppRoute.settings.path);
    await tester.pumpAndSettle();

    tester.element(find.byType(SettingsScreen)).pushThanks(restored: true);
    await tester.pumpAndSettle();

    final AppStrings strings = AppStrings.of(tester.element(find.byType(ThanksScreen)));
    expect(find.text(strings.thanksRestoredTitle), findsOneWidget);

    await tester.tap(find.text(strings.thanksStart));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '復元してきた場所に戻す');
  });
}
