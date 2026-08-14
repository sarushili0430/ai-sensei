import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:purchases_flutter/purchases_flutter.dart';
import 'package:purchases_ui_flutter/purchases_ui_flutter.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import 'revenuecat_config.dart';

part 'purchases_repository.g.dart';

/// The single entry point to the RevenueCat SDK (repository = SSOT).
///
/// The SDK is a bundle of static methods, so calling it from a controller
/// cannot be faked in tests. Confining it here lets tests override
/// [purchasesRepositoryProvider] wholesale.
class PurchasesRepository {
  const PurchasesRepository();

  /// Called exactly once at startup, from `main()`.
  ///
  /// This used to run inside a controller's `build()`, which reconfigured on
  /// every provider rebuild — not how the SDK is meant to be used. Init belongs
  /// to the app's lifetime, so it happens once.
  Future<void> configure({required String appUserId}) async {
    if (!RevenueCatConfig.isConfigured) return;
    if (await Purchases.isConfigured) return;

    // Billing bugs are untraceable without logs; keep info even in release.
    await Purchases.setLogLevel(kDebugMode ? LogLevel.debug : LogLevel.info);

    await Purchases.configure(configurationFor(appUserId));
  }

  /// The configuration object, split out so tests can read it.
  ///
  /// `Purchases.configure` hits a platform channel and cannot run in tests.
  /// Separating the value assembly pins the promise that data-collection
  /// defaults are explicitly turned off (same approach as `Telemetry`'s
  /// `DegradationEvent`).
  @visibleForTesting
  static PurchasesConfiguration configurationFor(String appUserId) {
    return PurchasesConfiguration(RevenueCatConfig.apiKey)
        // No accounts, so the anonymous device ID becomes the appUserID. This
        // value arrives as the webhook's app_user_id
        // (backend/api/src/routes/webhooks.ts).
        ..appUserID = appUserId
        // Let the OS surface store-side messages (an expired payment method,
        // say) automatically — we could not detect those ourselves.
        ..shouldShowInAppMessagesAutomatically = true
        // The SDK default is true: it sends ad identifiers (iOS `$idfa` /
        // `$idfv` / `$ip`, Android `$gpsAdId` / `$androidId` / `$ip`) to
        // RevenueCat once an attribution ID is set.
        //
        // We use no attribution, so nothing is sent today. It is still turned
        // off explicitly, for two reasons:
        //   1. Adding one line like `setAdjustID` later would silently start
        //      streaming minors' ad identifiers — far too much for one line
        //   2. Relying on the default means nobody notices if an SDK update
        //      changes it (as happened with Sentry's `enablePrintBreadcrumbs`)
        ..automaticDeviceIdentifierCollectionEnabled = false
        // Already false by default; stated anyway, for the same reason. It sends
        // response times and error codes to RevenueCat and has no bearing on
        // whether a purchase succeeds.
        ..diagnosticsEnabled = false;
  }

  Future<CustomerInfo> customerInfo() => Purchases.getCustomerInfo();

  /// Has the SDK push purchases, renewals, expiries and restores.
  ///
  /// This is what lets changes made inside the paywall or Customer Center land
  /// without reopening the screen. No polling needed.
  Stream<CustomerInfo> customerInfoChanges() {
    late final StreamController<CustomerInfo> controller;
    void listener(CustomerInfo info) => controller.add(info);

    controller = StreamController<CustomerInfo>.broadcast(
      onListen: () => Purchases.addCustomerInfoUpdateListener(listener),
      onCancel: () => Purchases.removeCustomerInfoUpdateListener(listener),
    );
    return controller.stream;
  }

  /// Offering to show: `REVENUECAT_OFFERING_ID` when set, otherwise current.
  Future<Offering?> currentOffering() async {
    final Offerings offerings = await Purchases.getOfferings();
    if (RevenueCatConfig.offeringId.isNotEmpty) {
      return offerings.getOffering(RevenueCatConfig.offeringId) ?? offerings.current;
    }
    return offerings.current;
  }

  /// Purchases. Failures arrive as [PlatformException], so callers should run
  /// them through `PurchaseOutcome.fromException` first.
  Future<CustomerInfo> purchase(Package package) async {
    // purchasePackage is deprecated; v10 unifies on PurchaseParams.
    final PurchaseResult result = await Purchases.purchase(PurchaseParams.package(package));
    return result.customerInfo;
  }

  /// Restore. Required by App Review, and needed after a device change or a
  /// reinstall.
  Future<CustomerInfo> restore() => Purchases.restorePurchases();

  /// Shows the paywall built in the RevenueCat dashboard.
  Future<PaywallResult> presentPaywall({Offering? offering}) =>
      RevenueCatUI.presentPaywall(offering: offering, displayCloseButton: true);

  /// Shows the paywall only without an entitlement; with one it simply returns
  /// [PaywallResult.notPresented] and does nothing.
  Future<PaywallResult> presentPaywallIfNeeded({Offering? offering}) =>
      RevenueCatUI.presentPaywallIfNeeded(
        RevenueCatConfig.entitlementId,
        offering: offering,
        displayCloseButton: true,
      );

  /// Shows Customer Center: cancel, refund request, plan change and restore.
  ///
  /// Building our own is the kind of screen App Review flags every time, so we
  /// use RevenueCat's as is.
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
