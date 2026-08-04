import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:purchases_flutter/purchases_flutter.dart';
import 'package:purchases_ui_flutter/purchases_ui_flutter.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import 'revenuecat_config.dart';

part 'purchases_repository.g.dart';

/// RevenueCat SDK の唯一の出入口(handoff §5 の Repository = SSOT)。
///
/// SDKは static メソッドの集まりなので、Controller から直接呼ぶと
/// テストで差し替えられない。ここに閉じ込めて、テストでは
/// [purchasesRepositoryProvider] ごと override する。
class PurchasesRepository {
  const PurchasesRepository();

  /// 起動時に一度だけ呼ぶ(`main()`)。
  ///
  /// 以前は Controller の `build()` の中で configure していたが、
  /// provider が再構築されるたびに configure が走るのは想定外の使い方。
  /// SDK の初期化はアプリの寿命に紐づくので、起動時に一度だけにする。
  Future<void> configure({required String appUserId}) async {
    if (!RevenueCatConfig.isConfigured) return;
    if (await Purchases.isConfigured) return;

    // 課金の不具合はログが無いと追えない。リリースでも info は残す。
    await Purchases.setLogLevel(kDebugMode ? LogLevel.debug : LogLevel.info);

    await Purchases.configure(
      PurchasesConfiguration(RevenueCatConfig.apiKey)
        // アカウント作成を要求しないので、匿名デバイスIDをそのまま appUserID にする。
        // webhook の app_user_id にこの値が乗ってくる
        // (backend/api/src/routes/webhooks.ts)。
        ..appUserID = appUserId
        // ストア側の障害メッセージ(支払い方法の期限切れなど)は
        // OSに任せて自動で出す。自前で気づけない類のものなので。
        ..shouldShowInAppMessagesAutomatically = true,
    );
  }

  Future<CustomerInfo> customerInfo() => Purchases.getCustomerInfo();

  /// 購入・更新・失効・復元を SDK 側から push してもらう。
  ///
  /// これがあるので、ペイウォールや Customer Center の中で起きた変化も
  /// 画面を開き直さずに拾える。ポーリングは要らない。
  Stream<CustomerInfo> customerInfoChanges() {
    late final StreamController<CustomerInfo> controller;
    void listener(CustomerInfo info) => controller.add(info);

    controller = StreamController<CustomerInfo>.broadcast(
      onListen: () => Purchases.addCustomerInfoUpdateListener(listener),
      onCancel: () => Purchases.removeCustomerInfoUpdateListener(listener),
    );
    return controller.stream;
  }

  /// 出す Offering。`REVENUECAT_OFFERING_ID` があればそれ、無ければ current。
  Future<Offering?> currentOffering() async {
    final Offerings offerings = await Purchases.getOfferings();
    if (RevenueCatConfig.offeringId.isNotEmpty) {
      return offerings.getOffering(RevenueCatConfig.offeringId) ?? offerings.current;
    }
    return offerings.current;
  }

  /// 購入する。失敗は [PlatformException] で飛ぶので、呼び出し側で
  /// `PurchaseOutcome.fromException` に通してから扱う。
  Future<CustomerInfo> purchase(Package package) async {
    // purchasePackage は非推奨。10系では PurchaseParams に統一されている。
    final PurchaseResult result = await Purchases.purchase(PurchaseParams.package(package));
    return result.customerInfo;
  }

  /// 復元。App Review の必須要件で、機種変更とアンインストール後の復帰にも要る。
  Future<CustomerInfo> restore() => Purchases.restorePurchases();

  /// RevenueCat のダッシュボードで作ったペイウォールを出す。
  Future<PaywallResult> presentPaywall({Offering? offering}) =>
      RevenueCatUI.presentPaywall(offering: offering, displayCloseButton: true);

  /// entitlement を持っていなければペイウォールを出す。
  /// 持っていれば [PaywallResult.notPresented] が返るだけで何も起きない。
  Future<PaywallResult> presentPaywallIfNeeded({Offering? offering}) =>
      RevenueCatUI.presentPaywallIfNeeded(
        RevenueCatConfig.entitlementId,
        offering: offering,
        displayCloseButton: true,
      );

  /// Customer Center(解約・返金申請・プラン変更・復元の窓口)を出す。
  ///
  /// 自前で作ると App Review のたびに指摘される類の画面なので、
  /// RevenueCat のものをそのまま使う。
  Future<void> presentCustomerCenter({
    void Function(CustomerInfo info)? onRestoreCompleted,
    void Function()? onShowingManageSubscriptions,
  }) => RevenueCatUI.presentCustomerCenter(
    onRestoreCompleted: onRestoreCompleted,
    onShowingManageSubscriptions: onShowingManageSubscriptions,
  );
}

@Riverpod(keepAlive: true)
PurchasesRepository purchasesRepository(Ref ref) => const PurchasesRepository();
