/// App内課金の**審査用スクリーンショット**(ペイウォール)を実画面から書き出す。
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test \
///   --dart-define=TERMS_URL=https://ubiqy.jp/terms/ \
///   --dart-define=PRIVACY_POLICY_URL=https://ubiqy.jp/privacy/ \
///   tool/generate_iap_review_screenshot.dart
/// ```
///
/// App Store Connect のサブスクリプション商品には、1つずつ「審査用スクリーンショット」
/// (640×920 以上)が要る。3商品とも同じペイウォールが出るので同じ1枚でよい。
/// `generate_store_screenshots.dart` と同じ仕組みで本物の Widget ツリーを描く
/// (手描きのモックは Guideline 2.3.3 に触れる)。
///
/// 差し込むのは RevenueCat の Offering が返す形の3プラン。価格の文字列は
/// `docs/business/pricing_v1.md` の確定値を**ストアが返すのと同じ形**(`¥980` / `$6.99`)で
/// 入れてあるので、実機と同じ絵になる。月あたりの単価も Apple と同じ計算(週×52÷12)。
///
/// **規約とプライバシーポリシーのリンクは `--dart-define` が無いと行ごと消える**
/// (`LegalLinks` は空のURLでは描かない)。Guideline 3.1.2 で審査が見る場所なので、
/// 上のコマンドどおりに渡すこと。RevenueCat の鍵は渡さない —— 鍵の無いビルドが
/// 自前ペイウォール(`_ManualPaywall`)に落ちる経路をそのまま使う。
///
/// 出力: `docs/store/iap-review/paywall-{ja,en}.png`(1179×2556)
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

import '../test/support/harness.dart';

const String _outDir = '../../docs/store/iap-review';

/// iPhone 15 Pro の論理サイズ。×3 で 1179×2556。
const Size _logical = Size(393, 852);
const double _pixelRatio = 3;

const PresentedOfferingContext _context = PresentedOfferingContext(
  'default',
  null,
  null,
);

/// ストアから返ってきた体の商品。`priceString` は表示にそのまま使われる。
StoreProduct _product(
  String id, {
  required double price,
  required String priceString,
  required String currency,
  required double pricePerMonth,
  required String pricePerMonthString,
}) => StoreProduct(
  id,
  '',
  '',
  price,
  priceString,
  currency,
  pricePerMonth: pricePerMonth,
  pricePerMonthString: pricePerMonthString,
);

/// 確定した3プラン(docs/business/pricing_v1.md)。ロケールで通貨を分ける。
Offering _offering(String locale) {
  final bool ja = locale == 'ja';
  final Package weekly = Package(
    r'$rc_weekly',
    PackageType.weekly,
    ja
        ? _product(
            'jp.co.aisensei.premium.weekly',
            price: 980,
            priceString: '¥980',
            currency: 'JPY',
            pricePerMonth: 4247,
            pricePerMonthString: '¥4,247',
          )
        : _product(
            'jp.co.aisensei.premium.weekly',
            price: 6.99,
            priceString: r'$6.99',
            currency: 'USD',
            pricePerMonth: 30.29,
            pricePerMonthString: r'$30.29',
          ),
    _context,
  );
  final Package monthly = Package(
    r'$rc_monthly',
    PackageType.monthly,
    ja
        ? _product(
            'jp.co.aisensei.premium.monthly',
            price: 2980,
            priceString: '¥2,980',
            currency: 'JPY',
            pricePerMonth: 2980,
            pricePerMonthString: '¥2,980',
          )
        : _product(
            'jp.co.aisensei.premium.monthly',
            price: 19.99,
            priceString: r'$19.99',
            currency: 'USD',
            pricePerMonth: 19.99,
            pricePerMonthString: r'$19.99',
          ),
    _context,
  );
  final Package annual = Package(
    r'$rc_annual',
    PackageType.annual,
    ja
        ? _product(
            'jp.co.aisensei.premium.yearly',
            price: 29800,
            priceString: '¥29,800',
            currency: 'JPY',
            pricePerMonth: 2483,
            pricePerMonthString: '¥2,483',
          )
        : _product(
            'jp.co.aisensei.premium.yearly',
            price: 199.99,
            priceString: r'$199.99',
            currency: 'USD',
            pricePerMonth: 16.67,
            pricePerMonthString: r'$16.67',
          ),
    _context,
  );
  return Offering(
    'default',
    'The standard set of packages',
    const <String, Object>{},
    <Package>[weekly, monthly, annual],
    weekly: weekly,
    monthly: monthly,
    annual: annual,
  );
}

void main() {
  setUpAll(loadAppFonts);

  for (final String locale in <String>['ja', 'en']) {
    testWidgets('$locale paywall', (WidgetTester tester) async {
      await tester.binding.setSurfaceSize(_logical);
      tester.view.physicalSize = _logical;
      tester.view.devicePixelRatio = 1;
      addTearDown(() async {
        await tester.binding.setSurfaceSize(null);
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final GlobalKey key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: wrapApp(
            const PaywallScreen(),
            overrides: <Object?>[
              entitlementControllerProvider.overrideWith(
                () => FakeEntitlementController(
                  Entitlement(isPremium: false, offering: _offering(locale)),
                ),
              ),
            ],
            locale: Locale(locale),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // ラスタライズは本物の非同期を要るので runAsync の中で回す。
      await tester.runAsync(() async {
        final RenderRepaintBoundary boundary =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final ui.Image image = await boundary.toImage(pixelRatio: _pixelRatio);
        final ByteData? bytes = await image.toByteData(
          format: ui.ImageByteFormat.png,
        );
        final File file = File('$_outDir/paywall-$locale.png');
        file.parent.createSync(recursive: true);
        file.writeAsBytesSync(bytes!.buffer.asUint8List(), flush: true);
      });
    });
  }
}
