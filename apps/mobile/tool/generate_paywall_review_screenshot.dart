/// App Store Connect / Play Console の「審査に関する情報」に添付する
/// **ペイウォールのスクリーンショット**を実画面から書き出す。
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test tool/generate_paywall_review_screenshot.dart \
///   --dart-define-from-file=dart_defines.env
/// ```
///
/// 出力: `docs/store/review/{ja,en}/paywall.png`(1179x2556)
///
/// **`TERMS_URL` と `PRIVACY_POLICY_URL` を渡すこと。** 空だと
/// [LegalLinks] がまるごと消える(`external_link.dart` の `links.isEmpty`)。
/// 規約とプライバシーポリシーへのリンクは Guideline 3.1.2 の必須要素なので、
/// 写っていないスクショを添付すると審査で弾かれる。渡し忘れは下の
/// `setUpAll` で落とす。
///
/// ストア掲載用のスクショ(`tool/generate_store_screenshots.dart`)とは用途が別。
/// あちらは売り文句つきの5枚で、こちらは「この課金がアプリのどこで、
/// いくらで売られているか」を審査担当に見せるためだけの1枚。
/// App Store Connect は審査用スクショに **640x920 以上**を求めるので、
/// golden(`test/golden/goldens/paywall.png` = 393x852)は流用できない。
///
/// 価格はストアが返した文字列をそのまま出す作りなので、ここでは
/// 実際に登録する3プランと同じ値を持つ偽の [StoreProduct] を渡している。
/// **価格を変えたら、この定数とストアの登録内容を必ず揃えること。**
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/settings/data/support_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

import '../test/support/harness.dart';

const String _outDir = '../../docs/store/review';

/// iPhone 15 Pro の論理サイズ。×3で 1179x2556 になる。
const Size _logical = Size(393, 852);
const double _pixelRatio = 3;

void main() {
  setUpAll(() async {
    await loadAppFonts();

    // 規約・プライバシーのリンクが出ないビルドで撮ってしまうのを防ぐ。
    // 「撮れてはいるが必須要素が写っていない」が、一番気づかずに
    // 提出してしまう壊れ方なので、ここで止める。
    if (!SupportLinks.hasTerms || !SupportLinks.hasPrivacyPolicy) {
      fail(
        'TERMS_URL / PRIVACY_POLICY_URL が渡っていないので、ペイウォールに\n'
        '規約とプライバシーポリシーのリンクが出ない。審査で必須の要素なので\n'
        '写っていないスクショは使えない。次のように渡して実行すること:\n'
        '  flutter test tool/generate_paywall_review_screenshot.dart \\\n'
        '    --dart-define-from-file=dart_defines.env',
      );
    }
  });

  for (final String locale in <String>['ja', 'en']) {
    testWidgets('$locale ペイウォール(審査用)', (WidgetTester tester) async {
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
            locale: Locale(locale),
            overrides: <Object?>[
              entitlementControllerProvider.overrideWith(_FakeEntitlementController.new),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      // ラスタライズ(toImage)は本物の非同期を要るので runAsync の中で回す。
      await tester.runAsync(() async {
        final RenderRepaintBoundary boundary =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final ui.Image image = await boundary.toImage(pixelRatio: _pixelRatio);
        final Uint8List bytes =
            (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();

        final File file = File('$_outDir/$locale/paywall.png');
        file.parent.createSync(recursive: true);
        file.writeAsBytesSync(bytes, flush: true);
      });
    });
  }
}

// --- ストアに登録する3プランと同じ値 ---

const PresentedOfferingContext _context = PresentedOfferingContext('default', null, null);

/// 月あたり単価はストアが計算して返す値。ここでも同じ端数処理(四捨五入)で置く。
/// 週額は 52週 / 12か月、年額は 12か月で割ったもの。
StoreProduct _product(
  String id, {
  required double price,
  required String priceString,
  required double pricePerMonth,
  required String pricePerMonthString,
}) => StoreProduct(
  id,
  '',
  '',
  price,
  priceString,
  'JPY',
  pricePerMonth: pricePerMonth,
  pricePerMonthString: pricePerMonthString,
);

final Offering _offering = Offering(
  'default',
  '',
  const <String, Object>{},
  <Package>[
    Package(
      r'$rc_weekly',
      PackageType.weekly,
      _product(
        'jp.co.aisensei.premium.weekly',
        price: 580,
        priceString: '¥580',
        pricePerMonth: 2513,
        pricePerMonthString: '¥2,513',
      ),
      _context,
    ),
    Package(
      r'$rc_monthly',
      PackageType.monthly,
      _product(
        'jp.co.aisensei.premium.monthly',
        price: 1280,
        priceString: '¥1,280',
        pricePerMonth: 1280,
        pricePerMonthString: '¥1,280',
      ),
      _context,
    ),
    Package(
      r'$rc_annual',
      PackageType.annual,
      _product(
        'jp.co.aisensei.premium.yearly',
        price: 12800,
        priceString: '¥12,800',
        pricePerMonth: 1067,
        pricePerMonthString: '¥1,067',
      ),
      _context,
    ),
  ],
);

class _FakeEntitlementController extends EntitlementController {
  @override
  Future<Entitlement> build() async => Entitlement(offering: _offering, isPremium: false);
}
