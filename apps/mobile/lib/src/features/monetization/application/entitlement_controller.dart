import 'package:flutter/foundation.dart';
import 'package:purchases_flutter/purchases_flutter.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/device_id.dart';

part 'entitlement_controller.g.dart';

/// RevenueCat の entitlement。
///
/// 参加の絶対条件(RevenueCat SDKで最低1つのアプリ内課金)を満たす箇所。
/// **サーバ側の判定が正**で、ここはUIの出し分けにだけ使う。
/// クライアントの申告でセッション上限を緩めることはしない。
const String entitlementId = 'premium';

const String _iosKey = String.fromEnvironment('REVENUECAT_IOS_PUBLIC_SDK_KEY');
const String _androidKey = String.fromEnvironment('REVENUECAT_ANDROID_PUBLIC_SDK_KEY');

@immutable
class Entitlement {
  const Entitlement({required this.isPremium, this.offering});

  final bool isPremium;
  final Offering? offering;

  static const Entitlement free = Entitlement(isPremium: false);
}

@Riverpod(keepAlive: true)
class EntitlementController extends _$EntitlementController {
  @override
  Future<Entitlement> build() async {
    final String deviceId = ref.read(deviceIdProvider);
    final String apiKey = defaultTargetPlatform == TargetPlatform.android ? _androidKey : _iosKey;
    if (apiKey.isEmpty) return Entitlement.free;

    await Purchases.configure(PurchasesConfiguration(apiKey)..appUserID = deviceId);
    return _read();
  }

  Future<Entitlement> _read() async {
    final CustomerInfo info = await Purchases.getCustomerInfo();
    final Offerings offerings = await Purchases.getOfferings();
    return Entitlement(
      isPremium: info.entitlements.active.containsKey(entitlementId),
      offering: offerings.current,
    );
  }

  /// 7日間の無料トライアルつきで購入する。
  Future<void> purchase(Package package) async {
    state = const AsyncValue<Entitlement>.loading();
    state = await AsyncValue.guard(() async {
      await Purchases.purchase(PurchaseParams.package(package));
      return _read();
    });
  }

  /// 復元。App Reviewの必須要件。
  Future<void> restore() async {
    state = await AsyncValue.guard(() async {
      await Purchases.restorePurchases();
      return _read();
    });
  }
}

