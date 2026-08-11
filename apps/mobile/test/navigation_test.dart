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
    final ProviderContainer container = ProviderContainer(overrides: overrides.cast());
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

  testWidgets('狭い端末でも4タブがホームの操作を押し出さない', (WidgetTester tester) async {
    await setSurface(tester, size: smallPhoneSurface);
    await pumpRouter(tester, overrides: bootOverrides());

    expect(find.byKey(const ValueKey<String>('main-bottom-navigation')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('navigation-home')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('navigation-study-room')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('navigation-plan')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('navigation-settings')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('設定は下タブから開き、ホームタブへ戻れる', (WidgetTester tester) async {
    await pumpRouter(tester, overrides: bootOverrides());

    await tester.tap(find.byKey(const ValueKey<String>('navigation-settings')));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget);

    // 設定はもうホームへ積む寄り道ではなく、常設の枝。戻るスタックを
    // 捏造せず、同じ下部ナビゲーションからホームを選べることを出口にする。
    await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('ホーム → 親レポート は戻れる', (WidgetTester tester) async {
    final GoRouter router = await pumpRouter(tester, overrides: bootOverrides());

    // 穴の数は既存の進捗表示なので、課金の広告をホームへ増やさずに
    // 「今月できるようになったこと」の詳細へ自然につなげられる。
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

    // すでにPremiumだったため entitlement の false → true 通知は来ない。
    // この場合も、ペイウォールを閉じた境界でロック応答を捨てる必要がある。
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

    // 計画は独立した常設の枝になったので、ホームを下へ積む必要はない。
    // それでも直接着地が行き止まりにならないことは、タブそのもので固定する。
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

    // 選択中のホームをもう一度押したときは、枝の根へ戻れる。
    await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('撮影と祝福にはタブを出さない', (WidgetTester tester) async {
    // 撮影画面は初回フレームでカメラを開く。ここで見たいのは撮影結果ではなく
    // シェルの外にいることなので、撮らずに戻った結果だけを端末の代わりに返す。
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
    // コールドスタートで go('/review') される経路。push ではないので、
    // ルートを入れ子にしていないとスタックの深さが1になり行き止まりになる。
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

    // 無料なのは自己申告の小テストまで。音声授業を直接始める旧導線を
    // ナビゲーションテストに残すと、サーバのPremium境界との不一致を再導入してしまう。
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
