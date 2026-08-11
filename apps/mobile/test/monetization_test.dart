import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/features/monetization/data/purchases_repository.dart';
import 'package:ai_sensei/src/features/monetization/presentation/manage_subscription_button.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/thanks_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
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
  /// **SDKの既定のまま何が送られるか**(計画書 §10-7 で Sentry を塞いだのと同じ観点)。
  ///
  /// ユーザーは未成年で、問題文はR2にすら保存しないと決めている。
  /// 課金SDKに個人情報が流れたら、その決定は無効になる。
  group('RevenueCat の送信設定', () {
    /// **SDKの既定は true。** アトリビューションIDを設定した瞬間に
    /// 広告識別子(`$idfa` / `$gpsAdId` / `$androidId` / `$ip` など)が流れ始める。
    /// いまは使っていないが、**1行足しただけで未成年の端末から流れ出す**のは重すぎる。
    test('広告識別子の自動収集は、明示的に切ってある', () {
      expect(
        PurchasesRepository.configurationFor('device-1')
            .automaticDeviceIdentifierCollectionEnabled,
        isFalse,
      );
    });

    /// 既定でも false。**既定で安全なものも明示する** —— 既定に頼ると、
    /// SDKの更新で既定が変わったときに誰も気づけない。
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

    // ここを取り違えると、1円も払っていない人に「ご購入ありがとう」と出る。
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

    // intro は「初月100円」のような**有料の**入会キャンペーン。
    // 無料と一緒にすると、払っている人に「まだ無料です」と出る。
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

  // 無料期間の見出し(「7日間、ぜんぶ使えます」)に出る数。
  group('期限までの残り日数', () {
    final DateTime now = DateTime(2026, 8, 8, 21, 30);

    Entitlement until(DateTime? expiresAt) =>
        Entitlement(isPremium: true, expiresAt: expiresAt);

    // 7日ちょうどに数分足りないだけで「あと6日」と出ていた、を防ぐ。
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

    // 期限が読めないときは数を作らない。画面側は日数の無い見出しに落とす。
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

  // 「ご購入ありがとうございます」と書けない場合がある(§6 誠実さ)。
  // 見出しの出し分けが、いちばん壊れても気づきにくいところ。
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

    // まだ1円も払っていない。お礼を言うと事実として嘘になる。
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

    // 買い直していない。お礼を言うと二重に払ったのかと思わせる。
    testWidgets('復元にはお礼を言わない', (WidgetTester tester) async {
      await pumpThanks(tester, entitlement: premiumEntitlement, restored: true);

      expect(find.text(ja.thanksRestoredTitle), findsOneWidget);
      expect(find.text(ja.thanksTitle), findsNothing);
    });

    // 復元した相手がトライアル中でも、買い直してはいない。
    testWidgets('復元はトライアルより優先する', (WidgetTester tester) async {
      await pumpThanks(tester, entitlement: trialEntitlement(), restored: true);

      expect(find.text(ja.thanksRestoredTitle), findsOneWidget);
    });

    // 「Premiumになりました」だけでは、何が変わったのか分からない。
    testWidgets('解放されたものを、ペイウォールと同じ3つ出す', (WidgetTester tester) async {
      await pumpThanks(tester, entitlement: premiumEntitlement);

      expect(find.text(ja.thanksUnlockedSessions), findsOneWidget);
      expect(find.text(ja.thanksUnlockedHistory), findsOneWidget);
      expect(find.text(ja.thanksUnlockedFollowup), findsOneWidget);
    });
  });

  // 契約している印。**ランクや称号に見えたら失敗**(数えるのは連続日数と
  // 埋めた穴だけ — handoff §7)。ここでは出る/出ないだけを見る。
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
      expect(find.text(ja.homeEnoughForToday), findsOneWidget);
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

    // 設定の契約カード。画面ごと組まないのは、鍵の無いビルドでは
    // 「契約」セクションごと出さないため(押しても何も起きない行を置かない)。
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

    // 「あと◯日で終わります」と急かさない。終わる日と、それまで使えることを書く。
    testWidgets('解約予約済みなら終わる日に差し替える', (WidgetTester tester) async {
      await pumpCard(tester, cancelledEntitlement);

      expect(find.text(ja.premiumEndsOn('2026年9月8日')), findsOneWidget);
      expect(find.text(ja.premiumRenewsOn('2026年9月8日')), findsNothing);
    });

    // 無料期間は更新日ではなく、**課金が始まる日**を言う。
    testWidgets('無料トライアル中は課金の開始日を出す', (WidgetTester tester) async {
      final Entitlement trial = trialEntitlement();
      await pumpCard(tester, trial);

      expect(find.text(ja.premiumTrialBadge), findsOneWidget);
      expect(
        find.text(ja.premiumBillingStarts(ja.date(trial.expiresAt!))),
        findsOneWidget,
      );
    });

    // 契約していない人に「無料プランです」と書かない。
    // 設定を開くたびに売り込まれているように読める。
    testWidgets('契約が無ければカードごと出さない', (WidgetTester tester) async {
      await pumpApp(tester, const Scaffold(body: SubscriptionStatusCard()));

      expect(find.text(ja.premiumBadge), findsNothing);
    });
  });
}
