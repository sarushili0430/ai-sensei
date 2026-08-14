import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:purchases_flutter/purchases_flutter.dart';
import 'package:purchases_ui_flutter/purchases_ui_flutter.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../data/purchases_repository.dart';
import '../data/revenuecat_config.dart';
import '../domain/entitlement.dart';
import '../domain/purchase_outcome.dart';

export '../data/revenuecat_config.dart' show RevenueCatConfig;
export '../domain/entitlement.dart';
export '../domain/purchase_outcome.dart';

part 'entitlement_controller.g.dart';

/// RevenueCat entitlement.
///
/// This is where the hard requirement (at least one in-app purchase through the
/// RevenueCat SDK) is met. The server's verdict is authoritative; this drives UI
/// only and never relaxes session limits on the client's say-so.
///
/// SDK init already happened in `main()` via [PurchasesRepository.configure].
/// This controller only reads current state and issues purchases and restores.
@Riverpod(keepAlive: true)
class EntitlementController extends _$EntitlementController {
  @override
  Future<Entitlement> build() async {
    // Builds without keys disable billing entirely rather than erroring, so
    // unrelated screen tests are not dragged down.
    if (!RevenueCatConfig.isConfigured) return Entitlement.free;

    final PurchasesRepository repository = ref.watch(purchasesRepositoryProvider);

    // The SDK pushes renewals, expiries, purchases made inside the paywall and
    // cancellations from Customer Center, so state catches up without reopening
    // the screen.
    final StreamSubscription<CustomerInfo> subscription = repository
        .customerInfoChanges()
        .listen(_onCustomerInfo, onError: (Object _) {});
    ref.onDispose(subscription.cancel);

    return _read(repository);
  }

  Future<Entitlement> _read(PurchasesRepository repository) async {
    // Fetching the Offering goes over the network and can fail. The entitlement
    // verdict should survive even when the paywall cannot be shown, so this one
    // failure is swallowed into null.
    final (CustomerInfo info, Offering? offering) = await (
      repository.customerInfo(),
      repository.currentOffering().onError((Object error, StackTrace _) {
        debugPrint('RevenueCat: offering を取得できませんでした: $error');
        return null;
      }),
    ).wait;

    _warnIfMisconfigured(info, offering);
    return Entitlement.from(
      info: info,
      entitlementId: RevenueCatConfig.entitlementId,
      offering: offering,
    );
  }

  void _onCustomerInfo(CustomerInfo info) {
    state = AsyncValue<Entitlement>.data(
      Entitlement.from(
        info: info,
        entitlementId: RevenueCatConfig.entitlementId,
        // The Offering does not change on a CustomerInfo update; keep the last.
        offering: state.value?.offering,
      ),
    );
  }

  /// Surfaces dashboard/app configuration drift during development.
  ///
  /// These two fail in the hardest way to notice — purchases succeed and
  /// nothing happens — so they are logged even in release builds.
  void _warnIfMisconfigured(CustomerInfo info, Offering? offering) {
    if (offering == null || offering.availablePackages.isEmpty) {
      debugPrint(
        'RevenueCat: 表示できる Offering がありません。'
        'ダッシュボードで current offering にパッケージを追加してください。',
      );
    }
    final Set<String> known = info.entitlements.all.keys.toSet();
    if (known.isNotEmpty && !known.contains(RevenueCatConfig.entitlementId)) {
      debugPrint(
        'RevenueCat: entitlement "${RevenueCatConfig.entitlementId}" が見つかりません。'
        'ダッシュボード側にあるのは ${known.join(", ")} です。'
        '--dart-define=REVENUECAT_ENTITLEMENT_ID で合わせてください。',
      );
    }
  }

  /// Purchases.
  ///
  /// Cancellation is not a failure. The SDK throws even when the user simply
  /// closed the sheet, so results are folded into [PurchaseOutcome] first.
  Future<PurchaseOutcome> purchase(Package package) async {
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    final Entitlement previous = state.value ?? Entitlement.free;

    // Riverpod 3's AsyncNotifier keeps the previous value while loading, so
    // paywall prices stay on screen during a purchase (`state.value` still reads
    // the previous one).
    state = const AsyncValue<Entitlement>.loading();
    try {
      final CustomerInfo info = await repository.purchase(package);
      final Entitlement next = Entitlement.from(
        info: info,
        entitlementId: RevenueCatConfig.entitlementId,
        offering: previous.offering,
      );
      state = AsyncValue<Entitlement>.data(next);

      // Payment succeeded without an entitlement means the product is not
      // attached to the Entitlement in the dashboard. Never close as success.
      return next.isPremium ? const PurchaseSucceeded() : const PurchaseNotEntitled();
    } on PlatformException catch (error) {
      state = AsyncValue<Entitlement>.data(previous);
      return PurchaseOutcome.fromException(error);
    }
  }

  /// Restore. Required by App Review.
  Future<RestoreOutcome> restore() async {
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    final Entitlement previous = state.value ?? Entitlement.free;

    state = const AsyncValue<Entitlement>.loading();
    try {
      final CustomerInfo info = await repository.restore();
      final Entitlement next = Entitlement.from(
        info: info,
        entitlementId: RevenueCatConfig.entitlementId,
        offering: previous.offering,
      );
      state = AsyncValue<Entitlement>.data(next);
      // Separate "succeeded with nothing to restore" from "restored". Both are
      // successes, so neither is reported as a failure.
      return next.isPremium ? const RestoreSucceeded() : const RestoreFoundNothing();
    } on PlatformException catch (error) {
      state = AsyncValue<Entitlement>.data(previous);
      return RestoreOutcome.fromException(error);
    }
  }

  /// Waits for the Offering to settle.
  ///
  /// Called just before showing the paywall so a configured
  /// `REVENUECAT_OFFERING_ID` is not missed. Failure is swallowed, since
  /// RevenueCat falls back to current anyway.
  Future<Offering?> _resolvedOffering() async {
    try {
      return (await future).offering;
    } on Object {
      return null;
    }
  }

  /// Shows RevenueCat's paywall.
  ///
  /// [PaywallResult.error] means the dashboard has no paywall or the OS version
  /// is too old; callers should fall back to our own paywall.
  Future<PaywallResult> presentPaywall() async {
    if (!RevenueCatConfig.isConfigured) return PaywallResult.error;
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    try {
      final PaywallResult result = await repository.presentPaywall(
        offering: await _resolvedOffering(),
      );
      if (result == PaywallResult.purchased || result == PaywallResult.restored) {
        await refresh();
      }
      return result;
    } on PlatformException catch (error) {
      debugPrint('RevenueCat: ペイウォールを出せませんでした: $error');
      return PaywallResult.error;
    }
  }

  /// Shows the paywall only when not subscribed; used the moment a gated
  /// feature is touched.
  Future<PaywallResult> presentPaywallIfNeeded() async {
    if (!RevenueCatConfig.isConfigured) return PaywallResult.error;
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    try {
      final PaywallResult result = await repository.presentPaywallIfNeeded(
        offering: await _resolvedOffering(),
      );
      if (result == PaywallResult.purchased || result == PaywallResult.restored) {
        await refresh();
      }
      return result;
    } on PlatformException catch (error) {
      debugPrint('RevenueCat: ペイウォールを出せませんでした: $error');
      return PaywallResult.error;
    }
  }

  /// Shows Customer Center: cancel, refund request, plan change and restore.
  ///
  /// True when shown. False when the SDK is unconfigured or the OS is too old,
  /// in which case callers should fall back to the store's cancellation URL.
  Future<bool> presentCustomerCenter() async {
    if (!RevenueCatConfig.isConfigured) return false;
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    try {
      await repository.presentCustomerCenter(onRestoreCompleted: _onCustomerInfo);
      // A cancellation may not arrive via CustomerInfo push, since the
      // entitlement itself is unchanged until expiry. Re-read after closing.
      await refresh();
      return true;
    } on PlatformException catch (error) {
      debugPrint('RevenueCat: Customer Center を出せませんでした: $error');
      return false;
    }
  }

  /// Re-reads the latest state.
  Future<void> refresh() async {
    if (!RevenueCatConfig.isConfigured) return;
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    state = await AsyncValue.guard(() => _read(repository));
  }
}

/// Whether an entitlement is held; usually what screens read.
///
/// Loading and error both resolve to "not yet". Treating an undecided state as
/// Premium would hand out paid access for free.
@Riverpod(keepAlive: true)
bool isPremium(Ref ref) =>
    ref.watch(entitlementControllerProvider).value?.isPremium ?? false;
