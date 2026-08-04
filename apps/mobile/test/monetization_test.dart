import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

import 'support/harness.dart';

/// 課金まわりの純関数ユニット(テスト方針①)。
///
/// 見ているのは「SDKが動くか」ではなく、**SDKの返した値をこちらが
/// 取り違えていないか**。取り違えると「課金したのに使えない」という、
/// もっとも気づきにくい壊れ方をする。

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
}) => EntitlementInfo(
  identifier,
  true,
  willRenew,
  '2026-08-04T00:00:00Z',
  '2026-08-04T00:00:00Z',
  'jp.co.aisensei.premium.monthly',
  false,
  expirationDate: expirationDate,
);

void main() {
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

    // ダッシュボードの identifier とアプリの定数がずれた場合。
    // 課金は成立しているのに何も解放されない、という壊れ方をする。
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

      // backend の CANCELLATION の扱い(期限まで有効)と揃えてある。
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
      // わざと逆順(高い順)で渡す。年額へ誘導する並びにしないため。
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

    // 「初月100円」を「無料」と書かないための分岐。
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

    // これを失敗として扱うと、閉じただけの人にエラーを見せてしまう。
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

    // 商品IDやEntitlementの取り違え。開発中に気づきたいので独立させている。
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

  // 押した瞬間に課金されるのに「無料でためす」と書いてある、を防ぐ。
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

    // 0円でない導入価格は割引であって無料ではない。
    testWidgets('割引価格の商品にも「無料」と書かない', (WidgetTester tester) async {
      await pumpPaywall(
        tester,
        offeringWith(const IntroductoryPrice(100, '¥100', 'P1M', 1, PeriodUnit.month, 1)),
      );

      expect(find.text('このプランではじめる'), findsOneWidget);
      expect(find.textContaining('日間は無料'), findsNothing);
    });
  });
}

class FakeEntitlementController extends EntitlementController {
  FakeEntitlementController(this._entitlement);

  final Entitlement _entitlement;

  @override
  Future<Entitlement> build() async => _entitlement;
}
