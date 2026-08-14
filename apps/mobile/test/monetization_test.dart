import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/features/monetization/data/purchases_repository.dart';
import 'package:ai_sensei/src/features/monetization/presentation/manage_subscription_button.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/thanks_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

import 'support/harness.dart';

/// Pure unit tests for billing.
///
/// They check not that the SDK works but that we do not misread what it
/// returns — a misread produces "paid but unusable", the hardest failure to
/// notice.

const PresentedOfferingContext _context = PresentedOfferingContext('default', null, null);

StoreProduct _product(
  String id, {
  required double price,
  double? pricePerMonth,
  IntroductoryPrice? intro,
}) => StoreProduct(
  id,
  '',
  '',
  price,
  '¥${price.toStringAsFixed(0)}',
  'JPY',
  introductoryPrice: intro,
  pricePerMonth: pricePerMonth,
  pricePerMonthString: pricePerMonth == null ? null : '¥${pricePerMonth.toStringAsFixed(0)}',
);

Package _package(String id, PackageType type, StoreProduct product) =>
    Package(id, type, product, _context);

CustomerInfo _customerInfo({
  Map<String, EntitlementInfo> active = const <String, EntitlementInfo>{},
  Map<String, EntitlementInfo>? all,
  String? managementUrl,
}) => CustomerInfo(
  EntitlementInfos(all ?? active, active),
  const <String, String?>{},
  const <String>[],
  const <String>[],
  const <StoreTransaction>[],
  '2026-08-01T00:00:00Z',
  'device-1',
  const <String, String?>{},
  '2026-08-04T00:00:00Z',
  managementURL: managementUrl,
);

EntitlementInfo _entitlementInfo({
  String identifier = 'premium',
  bool willRenew = true,
  String? expirationDate = '2026-09-04T00:00:00Z',
  PeriodType periodType = PeriodType.normal,
}) => EntitlementInfo(
  identifier,
  true,
  willRenew,
  '2026-08-04T00:00:00Z',
  '2026-08-04T00:00:00Z',
  'jp.co.aisensei.premium.monthly',
  false,
  expirationDate: expirationDate,
  periodType: periodType,
);

void main() {
  /// What the SDK sends at its defaults (the same lens as closing Sentry).
  ///
  /// Users are minors, and we decided not to store problem text even in R2.
  /// Personal data leaking into the billing SDK would void that decision.
  group('RevenueCat の送信設定', () {
    /// The SDK default is true: setting an attribution ID starts sending ad
    /// identifiers (`$idfa`, `$gpsAdId`, `$androidId`, `$ip`). We use none today,
    /// but one added line streaming them off minors' devices is too much.
    test('広告識別子の自動収集は、明示的に切ってある', () {
      expect(
        PurchasesRepository.configurationFor('device-1')
            .automaticDeviceIdentifierCollectionEnabled,
        isFalse,
      );
    });

    /// Already false by default, but stated explicitly: relying on a default
    /// means nobody notices when an SDK update changes it.
    test('診断情報の送信も、明示的に切ってある', () {
      expect(PurchasesRepository.configurationFor('device-1').diagnosticsEnabled, isFalse);
    });

    test('匿名のデバイスIDがそのまま appUserID になる(アカウントを作らせない)', () {
      expect(PurchasesRepository.configurationFor('device-1').appUserID, 'device-1');
    });
  });

  group('設定', () {
    test('鍵が無いビルドでは課金を無効にする(テスト・CIがこの経路)', () {
      expect(RevenueCatConfig.isConfigured, isFalse);
    });

    test('Entitlement identifier の既定は premium(ダッシュボードと一致させる)', () {
      expect(RevenueCatConfig.entitlementId, 'premium');
    });
  });

  group('Entitlement.from', () {
    test('該当する entitlement が active にあれば Premium', () {
      final Entitlement entitlement = Entitlement.from(
        info: _customerInfo(
          active: <String, EntitlementInfo>{'premium': _entitlementInfo()},
        ),
        entitlementId: 'premium',
      );

      expect(entitlement.isPremium, isTrue);
      expect(entitlement.expiresAt, DateTime.utc(2026, 9, 4).toLocal());
      expect(entitlement.isCancelled, isFalse);
    });

    // When the dashboard identifier and the app constant disagree: the purchase
    // succeeds and nothing unlocks.
    test('identifier がずれていれば Premium にならない', () {
      final Entitlement entitlement = Entitlement.from(
        info: _customerInfo(
          active: <String, EntitlementInfo>{'かたるて Pro': _entitlementInfo(identifier: 'かたるて Pro')},
        ),
        entitlementId: 'premium',
      );

      expect(entitlement.isPremium, isFalse);
    });

    test('解約予約済みでも期限までは Premium のまま', () {
      final Entitlement entitlement = Entitlement.from(
        info: _customerInfo(
          active: <String, EntitlementInfo>{'premium': _entitlementInfo(willRenew: false)},
        ),
        entitlementId: 'premium',
      );

      // Matches the backend's CANCELLATION handling (valid until expiry).
      expect(entitlement.isPremium, isTrue);
      expect(entitlement.isCancelled, isTrue);
    });

    test('契約が無くても管理URLがあれば契約の管理を出す(過去に契約していた人)', () {
      final Entitlement entitlement = Entitlement.from(
        info: _customerInfo(managementUrl: 'https://apps.apple.com/account/subscriptions'),
        entitlementId: 'premium',
      );

      expect(entitlement.isPremium, isFalse);
      expect(entitlement.canManageSubscription, isTrue);
    });

    test('何も無ければ無料', () {
      final Entitlement entitlement =
          Entitlement.from(info: _customerInfo(), entitlementId: 'premium');

      expect(entitlement.isPremium, isFalse);
      expect(entitlement.canManageSubscription, isFalse);
      expect(entitlement.plans, isEmpty);
    });

    // Misreading this thanks someone who has paid nothing for their purchase.
    test('無料トライアル中を見分ける', () {
      final Entitlement entitlement = Entitlement.from(
        info: _customerInfo(
          active: <String, EntitlementInfo>{
            'premium': _entitlementInfo(periodType: PeriodType.trial),
          },
        ),
        entitlementId: 'premium',
      );

      expect(entitlement.isTrial, isTrue);
    });

    // intro is a paid intro offer. Lumping it in with free tells someone who is
    // paying that they are still on a free trial.
    test('有料の入会キャンペーンは無料トライアルにしない', () {
      for (final PeriodType type in <PeriodType>[
        PeriodType.intro,
        PeriodType.normal,
        PeriodType.prepaid,
      ]) {
        final Entitlement entitlement = Entitlement.from(
          info: _customerInfo(
            active: <String, EntitlementInfo>{
              'premium': _entitlementInfo(periodType: type),
            },
          ),
          entitlementId: 'premium',
        );

        expect(entitlement.isTrial, isFalse, reason: '$type');
      }
    });
  });

  // The number shown in the trial heading.
  group('期限までの残り日数', () {
    final DateTime now = DateTime(2026, 8, 8, 21, 30);

    Entitlement until(DateTime? expiresAt) =>
        Entitlement(isPremium: true, expiresAt: expiresAt);

    // Prevents "6 days left" when it is minutes short of exactly 7.
    test('端数は切り上げる', () {
      expect(until(now.add(const Duration(days: 7))).daysLeft(now), 7);
      expect(
        until(now.add(const Duration(days: 7) - const Duration(minutes: 5))).daysLeft(now),
        7,
      );
      expect(until(now.add(const Duration(hours: 1))).daysLeft(now), 1);
    });

    test('切れていれば0', () {
      expect(until(now.subtract(const Duration(days: 1))).daysLeft(now), 0);
    });

    // With no readable expiry, invent no number; the screen drops to a heading
    // without days.
    test('期限が無ければ0', () {
      expect(until(null).daysLeft(now), 0);
    });
  });

  group('plansOf', () {
    final Package weekly =
        _package('\$rc_weekly', PackageType.weekly, _product('w', price: 280, pricePerMonth: 1213));
    final Package monthly =
        _package('\$rc_monthly', PackageType.monthly, _product('m', price: 580, pricePerMonth: 580));
    final Package yearly =
        _package('\$rc_annual', PackageType.annual, _product('y', price: 5800, pricePerMonth: 483));

    Offering offering(List<Package> packages) =>
        Offering('default', '', const <String, Object>{}, packages);

    test('ダッシュボードの並びによらず 週 → 月 → 年 の順で出す', () {
      // Passed deliberately in reverse (most expensive first), so the ordering
      // cannot steer towards the annual plan.
      final List<SubscriptionPlan> plans =
          plansOf(offering(<Package>[yearly, monthly, weekly]));

      expect(
        plans.map((SubscriptionPlan it) => it.period),
        <PlanPeriod>[PlanPeriod.weekly, PlanPeriod.monthly, PlanPeriod.yearly],
      );
    });

    test('扱わないパッケージ(lifetimeなど)は黙って落とす', () {
      final Package lifetime =
          _package('\$rc_lifetime', PackageType.lifetime, _product('l', price: 20000));
      final List<SubscriptionPlan> plans = plansOf(offering(<Package>[monthly, lifetime]));

      expect(plans, hasLength(1));
      expect(plans.single.period, PlanPeriod.monthly);
    });

    test('月あたりが最も安いプランにだけ「いちばん安い」が立つ', () {
      final List<SubscriptionPlan> plans =
          plansOf(offering(<Package>[weekly, monthly, yearly]));

      expect(
        plans.where((SubscriptionPlan it) => it.isBestValue).map((SubscriptionPlan it) => it.period),
        <PlanPeriod>[PlanPeriod.yearly],
      );
    });

    test('月あたり単価が取れないストアでは、いちばん安いを出さない', () {
      final Package noPerMonth =
          _package('\$rc_annual', PackageType.annual, _product('y', price: 5800));
      final List<SubscriptionPlan> plans = plansOf(offering(<Package>[monthly, noPerMonth]));

      expect(plans.any((SubscriptionPlan it) => it.isBestValue), isFalse);
    });

    test('Offering が無ければ空', () {
      expect(plansOf(null), isEmpty);
    });
  });

  group('無料トライアルの日数', () {
    SubscriptionPlan plan(IntroductoryPrice? intro) => SubscriptionPlan(
      package: _package(
        '\$rc_monthly',
        PackageType.monthly,
        _product('m', price: 580, intro: intro),
      ),
      period: PlanPeriod.monthly,
    );

    test('0円の導入価格を無料トライアルとして数える', () {
      expect(
        plan(const IntroductoryPrice(0, '¥0', 'P1W', 1, PeriodUnit.week, 1)).freeTrialDays,
        7,
      );
    });

    // The branch that stops a discounted intro price being called "free".
    test('有料の導入価格は無料トライアルにしない', () {
      final SubscriptionPlan discounted =
          plan(const IntroductoryPrice(100, '¥100', 'P1M', 1, PeriodUnit.month, 1));

      expect(discounted.freeTrialDays, 0);
      expect(discounted.hasFreeTrial, isFalse);
    });

    test('導入価格が無ければトライアルも無い', () {
      expect(plan(null).hasFreeTrial, isFalse);
    });
  });

  group('購入の結果', () {
    PlatformException error(PurchasesErrorCode code) =>
        PlatformException(code: PurchasesErrorCode.values.indexOf(code).toString());

    // Treating this as failure shows an error to someone who merely closed it.
    test('キャンセルは失敗ではない', () {
      expect(
        PurchaseOutcome.fromException(error(PurchasesErrorCode.purchaseCancelledError)),
        isA<PurchaseCancelled>(),
      );
    });

    test('通信の失敗は「時間をおけば直る」側に分類する', () {
      final PurchaseOutcome outcome =
          PurchaseOutcome.fromException(error(PurchasesErrorCode.networkError));

      expect(outcome, isA<PurchaseFailed>());
      expect((outcome as PurchaseFailed).failure, PurchaseFailure.network);
    });

    test('購入済みは復元へ誘導する分類にする', () {
      final PurchaseOutcome outcome =
          PurchaseOutcome.fromException(error(PurchasesErrorCode.productAlreadyPurchasedError));

      expect((outcome as PurchaseFailed).failure, PurchaseFailure.alreadyOwned);
    });

    // Wrong product ID or entitlement. Kept separate so it is caught in dev.
    test('設定ミスは configuration にまとめる', () {
      for (final PurchasesErrorCode code in <PurchasesErrorCode>[
        PurchasesErrorCode.configurationError,
        PurchasesErrorCode.invalidCredentialsError,
        PurchasesErrorCode.productNotAvailableForPurchaseError,
      ]) {
        expect(
          (PurchaseOutcome.fromException(error(code)) as PurchaseFailed).failure,
          PurchaseFailure.configuration,
          reason: '$code',
        );
      }
    });

    test('知らないコードは unknown に落ちる(画面は汎用文言で出す)', () {
      expect(
        (PurchaseOutcome.fromException(error(PurchasesErrorCode.unknownError)) as PurchaseFailed)
            .failure,
        PurchaseFailure.unknown,
      );
    });

    test('復元の失敗も同じ分類を使う', () {
      final RestoreOutcome outcome =
          RestoreOutcome.fromException(error(PurchasesErrorCode.networkError));

      expect((outcome as RestoreFailed).failure, PurchaseFailure.network);
    });
  });

  // Prevents "try it free" on a button that bills on the first tap.
  group('ペイウォールの購入ボタン', () {
    Future<void> pumpPaywall(WidgetTester tester, Offering offering) => pumpApp(
      tester,
      const PaywallScreen(),
      overrides: <Object?>[
        entitlementControllerProvider.overrideWith(
          () => FakeEntitlementController(
            Entitlement(isPremium: false, offering: offering),
          ),
        ),
      ],
    );

    Offering offeringWith(IntroductoryPrice? intro) => Offering(
      'default',
      '',
      const <String, Object>{},
      <Package>[
        _package(
          '\$rc_monthly',
          PackageType.monthly,
          _product('m', price: 580, intro: intro),
        ),
      ],
    );

    testWidgets('無料トライアルがある商品なら日数を出す', (WidgetTester tester) async {
      await pumpPaywall(
        tester,
        offeringWith(const IntroductoryPrice(0, '¥0', 'P1W', 1, PeriodUnit.week, 1)),
      );

      expect(find.text('はじめの7日間は無料'), findsWidgets);
    });

    testWidgets('トライアルが無い商品に「無料」と書かない', (WidgetTester tester) async {
      await pumpPaywall(tester, offeringWith(null));

      expect(find.text('このプランではじめる'), findsOneWidget);
      expect(find.textContaining('無料でためす'), findsNothing);
      expect(find.textContaining('日間は無料'), findsNothing);
    });

    // A non-zero intro price is a discount, not free.
    testWidgets('割引価格の商品にも「無料」と書かない', (WidgetTester tester) async {
      await pumpPaywall(
        tester,
        offeringWith(const IntroductoryPrice(100, '¥100', 'P1M', 1, PeriodUnit.month, 1)),
      );

      expect(find.text('このプランではじめる'), findsOneWidget);
      expect(find.textContaining('日間は無料'), findsNothing);
    });
  });

  // Prevents deciding to buy against a hard-coded price the Offering disagrees
  // with.
  group('祝福画面の Premium の一行', () {
    const AppStrings ja = AppStrings(Locale('ja'));

    Offering offeringWith(IntroductoryPrice? intro) => Offering(
      'default',
      '',
      const <String, Object>{},
      <Package>[
        _package(
          '\$rc_monthly',
          PackageType.monthly,
          _product('m', price: 580, intro: intro),
        ),
      ],
    );

    Future<void> pumpCelebration(
      WidgetTester tester,
      Entitlement entitlement,
    ) => pumpApp(
      tester,
      const CelebrationScreen(),
      overrides: <Object?>[
        progressControllerProvider.overrideWith(FakeProgressController.new),
        latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
        sessionOutcomeControllerProvider.overrideWith(
          () => FakeSessionOutcomeController(const SessionOutcome(showPaywall: true)),
        ),
        entitlementControllerProvider.overrideWith(
          () => FakeEntitlementController(entitlement),
        ),
      ],
    );

    Future<void> pumpPaywall(
      WidgetTester tester,
      Entitlement entitlement,
    ) => pumpApp(
      tester,
      const PaywallScreen(),
      overrides: <Object?>[
        entitlementControllerProvider.overrideWith(
          () => FakeEntitlementController(entitlement),
        ),
      ],
    );

    testWidgets('Offering が取れていれば、その価格とトライアルを出す',
        (WidgetTester tester) async {
      await pumpCelebration(
        tester,
        Entitlement(
          isPremium: false,
          offering: offeringWith(
            const IntroductoryPrice(0, '¥0', 'P1W', 1, PeriodUnit.week, 1),
          ),
        ),
      );

      expect(find.text('Premium 1か月 ¥580'), findsOneWidget);
      expect(find.text('はじめの7日間は無料'), findsOneWidget);
    });

    testWidgets('Offering が取れていなければ、価格を約束しない',
        (WidgetTester tester) async {
      await pumpCelebration(tester, const Entitlement(isPremium: false));

      expect(find.textContaining('¥'), findsNothing);
      expect(find.textContaining('日間は無料'), findsNothing);
      expect(find.text(ja.paywallPricePending), findsOneWidget);
    });

    testWidgets('トライアルの無い商品に「無料」と書かない', (WidgetTester tester) async {
      await pumpCelebration(
        tester,
        Entitlement(isPremium: false, offering: offeringWith(null)),
      );

      expect(find.textContaining('日間は無料'), findsNothing);
      expect(find.text('Premium 1か月 ¥580'), findsOneWidget);
    });

    testWidgets('ペイウォールも Offering が空なら据え置きの価格を出さない',
        (WidgetTester tester) async {
      await pumpPaywall(tester, const Entitlement(isPremium: false));

      expect(find.textContaining('¥580'), findsNothing);
      expect(find.text(ja.paywallPriceUnavailable), findsOneWidget);
    });
  });

  // There are cases where "thank you for your purchase" cannot be written.
  // Choosing between the headings is the easiest thing to break unnoticed.
  group('購入のお礼', () {
    const AppStrings ja = AppStrings(Locale('ja'));

    Future<void> pumpThanks(
      WidgetTester tester, {
      required Entitlement entitlement,
      bool restored = false,
    }) => pumpApp(
      tester,
      ThanksScreen(restored: restored),
      overrides: premiumOverrides(entitlement),
    );

    testWidgets('買った人にはお礼を言い、更新日と解約できることを添える', (WidgetTester tester) async {
      await pumpThanks(tester, entitlement: premiumEntitlement);

      expect(find.text(ja.thanksTitle), findsOneWidget);
      expect(find.text(ja.thanksRenewsOn('2026年9月8日')), findsOneWidget);
    });

    // Nothing has been paid, so thanks would be factually false.
    testWidgets('無料トライアルにはお礼を言わず、課金が始まる日を先に出す', (WidgetTester tester) async {
      final Entitlement trial = trialEntitlement();
      await pumpThanks(tester, entitlement: trial);

      expect(find.text(ja.thanksTrialTitle(7)), findsOneWidget);
      expect(find.text(ja.thanksTitle), findsNothing);
      expect(
        find.text(ja.thanksTrialBody(ja.date(trial.expiresAt!))),
        findsOneWidget,
      );
    });

    // Nothing was re-bought; thanks would suggest they paid twice.
    testWidgets('復元にはお礼を言わない', (WidgetTester tester) async {
      await pumpThanks(tester, entitlement: premiumEntitlement, restored: true);

      expect(find.text(ja.thanksRestoredTitle), findsOneWidget);
      expect(find.text(ja.thanksTitle), findsNothing);
    });

    // Even restoring into a trial, nothing was re-bought.
    testWidgets('復元はトライアルより優先する', (WidgetTester tester) async {
      await pumpThanks(tester, entitlement: trialEntitlement(), restored: true);

      expect(find.text(ja.thanksRestoredTitle), findsOneWidget);
    });

    // "You're Premium now" alone does not say what changed.
    testWidgets('解放されたものを、ペイウォールと同じ3つ出す', (WidgetTester tester) async {
      await pumpThanks(tester, entitlement: premiumEntitlement);

      expect(find.text(ja.thanksUnlockedSessions), findsOneWidget);
      expect(find.text(ja.thanksUnlockedHistory), findsOneWidget);
      expect(find.text(ja.thanksUnlockedFollowup), findsOneWidget);
    });
  });

  // The subscribed marker. Looking like a rank or title is a failure; we count
  // only streak days and filled gaps. These check only whether it shows.
  group('Premium の印', () {
    const AppStrings ja = AppStrings(Locale('ja'));

    testWidgets('契約していればホームの右上に出る', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const HomeScreen(),
        overrides: <Object?>[
          progressControllerProvider.overrideWith(
            () => FakeProgressController(premiumExhaustedSummary),
          ),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
          ...premiumOverrides(),
        ],
      );

      expect(find.text(ja.premiumBadge), findsOneWidget);
      expect(find.text(sampleKarte.holes.first.description), findsOneWidget);
      expect(find.textContaining('残っている穴'), findsNothing);
      expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
      expect(find.text(ja.homeUnlock), findsNothing);
    });

    testWidgets('契約していなければ何も出ない', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const HomeScreen(),
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
        ],
      );

      expect(find.text(ja.premiumBadge), findsNothing);
    });

    // The subscription card in settings. The whole screen is not built because
    // key-less builds omit the section entirely, so no row does nothing on tap.
    Future<void> pumpCard(WidgetTester tester, Entitlement entitlement) => pumpApp(
      tester,
      const Scaffold(body: SubscriptionStatusCard()),
      overrides: premiumOverrides(entitlement),
    );

    testWidgets('設定のカードに状態と次の更新日を出す', (WidgetTester tester) async {
      await pumpCard(tester, premiumEntitlement);

      expect(find.text(ja.premiumActive), findsOneWidget);
      expect(find.text(ja.premiumRenewsOn('2026年9月8日')), findsOneWidget);
    });

    // No "X days left" countdown; it states the end date and that access lasts
    // until then.
    testWidgets('解約予約済みなら終わる日に差し替える', (WidgetTester tester) async {
      await pumpCard(tester, cancelledEntitlement);

      expect(find.text(ja.premiumEndsOn('2026年9月8日')), findsOneWidget);
      expect(find.text(ja.premiumRenewsOn('2026年9月8日')), findsNothing);
    });

    // A trial states the billing start date, not the renewal date.
    testWidgets('無料トライアル中は課金の開始日を出す', (WidgetTester tester) async {
      final Entitlement trial = trialEntitlement();
      await pumpCard(tester, trial);

      expect(find.text(ja.premiumTrialBadge), findsOneWidget);
      expect(
        find.text(ja.premiumBillingStarts(ja.date(trial.expiresAt!))),
        findsOneWidget,
      );
    });

    // Never tell a non-subscriber "you're on the free plan"; it reads as a pitch
    // every time settings is opened.
    testWidgets('契約が無ければカードごと出さない', (WidgetTester tester) async {
      await pumpApp(tester, const Scaffold(body: SubscriptionStatusCard()));

      expect(find.text(ja.premiumBadge), findsNothing);
    });
  });
}
