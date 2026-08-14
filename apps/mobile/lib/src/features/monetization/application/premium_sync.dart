import 'dart:async';

import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../karte/application/karte_controllers.dart';
import '../../parent_report/application/parent_report_controller.dart';
// Entitlement is re-exported from the domain by entitlement_controller.
import 'entitlement_controller.dart';

part 'premium_sync.g.dart';

/// Wiring that re-reads the server's Premium verdict after a purchase.
/// `AiSenseiApp` watches it once at startup, like `PushSetup`.
///
/// Premium state is updated along two separate paths:
///
///   - the app's entitlement, pushed by the SDK right after purchase (instant)
///   - the server's `users.is_premium`, written by RevenueCat's webhook
///     (a few seconds later)
///
/// Screens gate on the server's value (whether a lesson can start on home and
/// review, and the parent report lock). ProgressController is keepAlive and
/// nobody re-reads it after startup, and the parent report holds its locked
/// response while the paywall sits on top.
///
/// Without this, buying leaves you free until the app restarts: even with the
/// webhook delivered and D1 marked Premium, the app still holds the
/// `is_premium: false` it read at launch.
@Riverpod(keepAlive: true)
class PremiumSync extends _$PremiumSync {
  /// The last entitlement seen.
  ///
  /// We avoid `ref.listen`'s `previous` so the logic does not hinge on whether
  /// the `AsyncLoading` during a purchase keeps the prior value. If it does not,
  /// `previous` is null and the purchase moment is exactly what gets missed.
  bool? _lastSeen;

  Future<void>? _inFlight;

  /// Waits for an in-flight sync; returns immediately when none is running.
  ///
  /// Screens catch up on their own by watching the provider, so this exists for
  /// callers that need to confirm it landed — mainly tests.
  Future<void> get settled => _inFlight ?? Future<void>.value();

  @override
  void build() {
    // Purchases, restores, Customer Center cancellations and expiries all pass
    // through here. The SDK's `addCustomerInfoUpdateListener` also arrives via
    // EntitlementController, so purchases finished inside the paywall land too.
    ref.listen<AsyncValue<Entitlement>>(entitlementControllerProvider, (
      AsyncValue<Entitlement>? _,
      AsyncValue<Entitlement> next,
    ) {
      final bool? seen = next.value?.isPremium;
      if (seen == null) return; // Not readable yet (loading / error).

      final bool? previous = _lastSeen;
      _lastSeen = seen;

      // Skip the first tick at startup: each controller's build() is about to
      // read anyway, so following it would just fetch the same thing twice.
      if (previous == null || previous == seen) return;

      _inFlight = sync(expectPremium: seen);
      unawaited(_inFlight);
    });
  }

  /// Re-reads until the server's verdict catches up with [expectPremium].
  ///
  /// The webhook lands a few seconds after purchase. If the first read
  /// disagrees, retry a few times with a gap. When the attempts run out we stop
  /// and take the server at its word rather than unlocking on the client's
  /// claim: a permanently broken webhook is a server-side fix, and overriding
  /// here would hide the breakage from everyone.
  Future<void> sync({
    required bool expectPremium,
    List<Duration> backoff = webhookBackoff,
  }) async {
    final ProgressController progress = ref.read(progressControllerProvider.notifier);

    for (int attempt = 0; ; attempt++) {
      await progress.refresh();
      final bool? server = ref.read(progressControllerProvider).value?.isPremium;
      if (server == expectPremium || attempt >= backoff.length) break;
      await Future<void>.delayed(backoff[attempt]);
    }

    // The parent report reads the same server verdict. Refetching immediately
    // after the entitlement changes can grab the pre-webhook locked response
    // again, so the cache is dropped once the wait above completes too. It is
    // autoDispose, so this starts no request for someone who never opened it.
    ref.invalidate(parentReportControllerProvider);
  }

  /// Gaps between webhook polls, about 15 seconds in total.
  ///
  /// It usually arrives within seconds, so the first or second attempt wins.
  /// Kept short so a missing webhook does not leave "it might still land"
  /// hanging indefinitely.
  static const List<Duration> webhookBackoff = <Duration>[
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
  ];
}
