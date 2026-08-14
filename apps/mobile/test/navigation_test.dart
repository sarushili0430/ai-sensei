import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/capture/presentation/capture_screen.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/thanks_screen.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/parent_report/application/parent_report_controller.dart';
import 'package:ai_sensei/src/features/parent_report/domain/parent_report.dart';
import 'package:ai_sensei/src/features/parent_report/presentation/parent_report_screen.dart';
import 'package:ai_sensei/src/features/plan/application/plan_controller.dart';
import 'package:ai_sensei/src/features/plan/presentation/plan_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/settings/presentation/settings_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/routing/routes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:go_router/go_router.dart';

import 'support/harness.dart';

/// Navigation tests.
///
/// What is checked is not appearance but whether every screen has a way out.
/// Originally every transition used `context.go()`, so the stack was always one
/// deep: no screen showed a back button and review was a dead end. A failure here
/// means it has regressed to that shape.
void main() {
  /// Values resolved at startup; in production main() injects them.
  List<Object?> bootOverrides({
    bool onboarded = true,
    bool premium = false,
    ReviewQueue? queue,
    Karte? karte,
    ParentReportController Function()? parentReportController,
  }) {
    return <Object?>[
      onboardedProvider.overrideWithValue(onboarded),
      deviceIdProvider.overrideWithValue('dev_test'),
      progressControllerProvider.overrideWith(FakeProgressController.new),
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(
          queue ?? const ReviewQueue(items: []),
        ),
      ),
      parentReportControllerProvider.overrideWith(
        parentReportController ??
            () => FakeParentReportController(sampleParentReportResponse),
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
    // Settings reads the school stage. `preferencesProvider` is meant to be
    // overridden in main(), so without it here the settings tab crashes on open.
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        preferencesProvider.overrideWithValue(preferences),
        ...overrides,
      ].cast(),
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(wrapRouter(container));
    await tester.pumpAndSettle();
    return container.read(appRouterProvider);
  }

  testWidgets('初回起動はオンボーディングから始まる', (WidgetTester tester) async {
    await pumpRouter(tester, overrides: bootOverrides(onboarded: false));
    expect(find.byType(OnboardingScreen), findsOneWidget);
  });

  testWidgets('通過済みならホームから始まる', (WidgetTester tester) async {
    await pumpRouter(tester, overrides: bootOverrides());
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('main-bottom-navigation')), findsOneWidget);
  });

  testWidgets('狭い端末でも3タブがホームの操作を押し出さない', (WidgetTester tester) async {
    await setSurface(tester, size: smallPhoneSurface);
    await pumpRouter(tester, overrides: bootOverrides());

    expect(find.byKey(const ValueKey<String>('main-bottom-navigation')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('navigation-home')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('navigation-plan')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('navigation-settings')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('設定は下タブから開き、ホームタブへ戻れる', (WidgetTester tester) async {
    await pumpRouter(tester, overrides: bootOverrides());

    await tester.tap(find.byKey(const ValueKey<String>('navigation-settings')));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget);

    // Settings is now a permanent branch, not a detour stacked on home. Rather
    // than fabricating a back stack, the exit is choosing home from the same
    // bottom navigation.
    await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('ホーム → 親レポート は戻れる', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides());

    // The gap count is already a progress display, so it leads naturally into
    // this month's detail without adding a billing ad to home.
    await tester.tap(find.byKey(const ValueKey<String>('parent-report-link')));
    await tester.pumpAndSettle();
    expect(find.byType(ParentReportScreen), findsOneWidget);

    expect(router.canPop(), isTrue, reason: '親レポートは共有前に閉じて戻れなければならない');
    router.pop();
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('Premiumのままペイウォールから戻っても親レポートを取り直す',
      (WidgetTester tester) async {
    final _NavigationParentReportSource source = _NavigationParentReportSource();
    final GoRouter router = await pumpRouter(
      tester,
      overrides: bootOverrides(
        premium: true,
        parentReportController: () => _NavigationParentReportController(source),
      ),
    );
    router.go(AppRoute.parentReport.path);
    await tester.pumpAndSettle();

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(ParentReportScreen)),
    );
    expect(find.textContaining(strings.parentReportLocked), findsOneWidget);
    expect(source.loads, 1);

    await tester.tap(find.text(strings.paywallCta));
    await tester.pumpAndSettle();
    expect(find.byType(PaywallScreen), findsOneWidget);

    // Already Premium, so no false -> true entitlement notification arrives. The
    // locked response must still be discarded when the paywall closes.
    router.pop();
    await tester.pumpAndSettle();

    expect(source.loads, 2);
    expect(find.byType(ParentReportScreen), findsOneWidget);
    expect(find.text(strings.parentReportPreviewNote), findsOneWidget);
    expect(find.textContaining(strings.parentReportLocked), findsNothing);
  });

  testWidgets('計画へ直接着地しても、ホームタブへ戻れる', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(
      tester,
      overrides: <Object?>[
        ...bootOverrides(),
        planControllerProvider.overrideWith(_ReadyPlanController.new),
      ],
    );

    router.go(AppRoute.plan.path);
    await tester.pumpAndSettle();
    expect(find.byType(PlanScreen), findsOneWidget);

    // Plan is its own permanent branch, so home need not be stacked beneath. The
    // tabs themselves pin that landing directly is not a dead end.
    await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('タブを切り替えても、ホーム枝の復習履歴を保つ', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(
      tester,
      overrides: <Object?>[
        ...bootOverrides(),
        planControllerProvider.overrideWith(_ReadyPlanController.new),
      ],
    );

    router.go(AppRoute.review.path);
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('navigation-plan')));
    await tester.pumpAndSettle();
    expect(find.byType(PlanScreen), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget, reason: '枝を作り直すと復習画面が失われる');

    // Re-tapping the selected home tab returns to the branch's root.
    await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('撮影と祝福にはタブを出さない', (WidgetTester tester) async {
    // Capture opens the camera on the first frame. What matters here is being
    // outside the shell, not the shot, so the stub just returns "cancelled".
    const MethodChannel pickerChannel = MethodChannel('plugins.flutter.io/image_picker');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      pickerChannel,
      (_) async => null,
    );
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(pickerChannel, null),
    );
    mockPermissionHandler();

    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides());
    router.push(AppRoute.capture.path);
    await tester.pumpAndSettle();
    expect(find.byType(CaptureScreen), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('main-bottom-navigation')),
      findsNothing,
      reason: '撮影中に別モードへ抜けられてはいけない',
    );

    router.pop();
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget, reason: '撮影をやめたら来た場所へ戻る');

    router.go(AppRoute.celebration.path);
    await tester.pumpAndSettle();
    expect(find.byType(CelebrationScreen), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('main-bottom-navigation')),
      findsNothing,
      reason: '授業直後にも会話から別モードへ抜けるタブを出さない',
    );
  });

  testWidgets('通知から復習画面へ直接着地しても、下にホームが積まれている', (WidgetTester tester) async {
    // The cold-start path where go('/review') fires. It is not a push, so without
    // nested routes the stack is one deep and becomes a dead end.
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides());

    router.go(AppRoute.review.path);
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget);

    expect(router.canPop(), isTrue, reason: '通知から来ても、ホームへ戻れなければならない');
    router.pop();
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('復習画面は、穴がひとつも無くても出口がある', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides());
    router.go(AppRoute.review.path);
    await tester.pumpAndSettle();

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(ReviewScreen)),
    );
    await tester.tap(find.text(strings.reviewBackHome));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('無料の小テストから、声で聞き直す授業のPremium導線へ進める',
      (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(
      tester,
      overrides: bootOverrides(
        queue: sampleReviewQueue,
      ),
    );
    router.go(AppRoute.review.path);
    await tester.pumpAndSettle();

    final AppStrings strings = AppStrings.of(tester.element(find.byType(ReviewScreen)));
    expect(find.text(sampleReviewQueue.items.first.quiz), findsOneWidget);
    expect(find.text(strings.reviewSaidIt), findsOneWidget);
    expect(find.text(strings.reviewNotYet), findsOneWidget);
    expect(find.byType(PaywallScreen), findsNothing, reason: '小テスト自体は無料');

    await tester.tap(find.text(strings.reviewNotYet));
    await tester.pumpAndSettle();
    expect(find.text(strings.reviewNotYetLead), findsOneWidget);
    expect(find.text(strings.reviewVoicePremium), findsOneWidget);
    expect(find.text(strings.reviewAskSenpai), findsNothing);
    expect(find.text(strings.homeUnlock), findsOneWidget);
    expect(find.byType(PaywallScreen), findsNothing);

    // Free covers the self-reported quiz only. Keeping the old path that starts a
    // voice lesson directly would reintroduce a mismatch with the server's
    // Premium boundary.
    await tester.tap(find.text(strings.homeUnlock));
    await tester.pumpAndSettle();
    expect(find.byType(PaywallScreen), findsOneWidget);
    expect(router.canPop(), isTrue);
  });

  testWidgets('直近のカルテが無いのにカルテ画面へ行くと、ホームへ戻す', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides());

    router.go(AppRoute.karte.path);
    await tester.pumpAndSettle();

    expect(find.byType(KarteScreen), findsNothing);
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('直近のカルテがあればカルテ画面を出す', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(
      tester,
      overrides: bootOverrides(karte: sampleKarte),
    );

    router.go(AppRoute.karte.path);
    await tester.pumpAndSettle();
    expect(find.byType(KarteScreen), findsOneWidget);
  });

  // Payment succeeded without an entitlement (a dashboard misconfiguration) lands
  // here. Confetti followed by a locked app is the worst drop.
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

  // After buying, the only thing to go back to would be the buy screen.
  testWidgets('お礼はペイウォールを差し替える(閉じても買う画面に戻らない)', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides(premium: true));

    router.push(AppRoute.paywall.path);
    await tester.pumpAndSettle();
    expect(find.byType(PaywallScreen), findsOneWidget);

    // The purchase just succeeded. No SDK call; only the path the screen uses.
    tester.element(find.byType(PaywallScreen)).replaceWithThanks();
    await tester.pumpAndSettle();
    expect(find.byType(ThanksScreen), findsOneWidget);

    final AppStrings strings = AppStrings.of(tester.element(find.byType(ThanksScreen)));
    await tester.tap(find.text(strings.thanksStart));
    await tester.pumpAndSettle();

    expect(find.byType(PaywallScreen), findsNothing, reason: 'ペイウォールは残っていてはいけない');
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  // Someone back after a device change: welcome them, then return to settings.
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

class _ReadyPlanController extends PlanController {
  @override
  PlanState build() => const PlanState(phase: PlanPhase.ready);

  @override
  Future<void> load() async {}
}

class _NavigationParentReportSource {
  int loads = 0;

  ParentReportResponse load() {
    loads += 1;
    return loads == 1 ? ParentReportResponse.locked : sampleParentReportResponse;
  }
}

class _NavigationParentReportController extends ParentReportController {
  _NavigationParentReportController(this.source);

  final _NavigationParentReportSource source;

  @override
  Future<ParentReportResponse> build() async => source.load();
}
