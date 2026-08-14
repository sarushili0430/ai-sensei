import 'package:flutter/foundation.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

/// Billing domain: a layer that reduces SDK types to what these screens need.
///
/// Everything here is a pure function or an immutable class, to maximise what
/// the pure-unit tier of the test strategy can cover.
///
/// The server's verdict is authoritative. This drives UI only and never relaxes
/// session limits on the client's say-so.

/// Billing periods. Of RevenueCat's [PackageType]s, only the three set up in
/// the dashboard (weekly / monthly / yearly) are handled.
enum PlanPeriod {
  weekly,
  monthly,
  yearly;

  /// Null when there is no match, so adding lifetime or a custom package just
  /// drops it silently instead of breaking the screen.
  static PlanPeriod? fromPackageType(PackageType type) => switch (type) {
    PackageType.weekly => PlanPeriod.weekly,
    PackageType.monthly => PlanPeriod.monthly,
    PackageType.annual => PlanPeriod.yearly,
    _ => null,
  };
}

/// One plan on the paywall. Price strings are used exactly as the store
/// returns them — we never assemble currency symbols or separators ourselves.
@immutable
class SubscriptionPlan {
  const SubscriptionPlan({
    required this.package,
    required this.period,
    this.isBestValue = false,
  });

  final Package package;
  final PlanPeriod period;

  /// The cheapest plan per month, set only when it can actually be computed.
  /// Presented as a fact, not a recommendation.
  final bool isBestValue;

  StoreProduct get product => package.storeProduct;

  String get priceString => product.priceString;

  /// "X per month": shows the yearly plan's value as a number, without a push.
  String? get pricePerMonthString => product.pricePerMonthString;

  double? get pricePerMonth => product.pricePerMonth;

  /// Free trial length in days; 0 means no trial.
  ///
  /// introductoryPrice also covers discounted prices, so only a zero price
  /// counts as free — a paid intro offer must never be called "free".
  int get freeTrialDays {
    final IntroductoryPrice? intro = product.introductoryPrice;
    if (intro == null || intro.price > 0) return 0;

    final int daysPerUnit = switch (intro.periodUnit) {
      PeriodUnit.day => 1,
      PeriodUnit.week => 7,
      PeriodUnit.month => 30,
      PeriodUnit.year => 365,
      PeriodUnit.unknown => 0,
    };
    // cycles is how many periods the price applies to; some implementations
    // return 0, so clamp to 1.
    final int cycles = intro.cycles <= 0 ? 1 : intro.cycles;
    return daysPerUnit * intro.periodNumberOfUnits * cycles;
  }

  bool get hasFreeTrial => freeTrialDays > 0;
}

/// Extracts the sellable plans from an Offering.
///
/// Order is fixed by period: weekly, monthly, yearly. We do not sort by price to
/// steer people towards the annual plan. Being independent of the dashboard's
/// package order also keeps the screen stable when the Offering changes.
List<SubscriptionPlan> plansOf(Offering? offering) {
  if (offering == null) return const <SubscriptionPlan>[];

  final List<({Package package, PlanPeriod period})> found =
      <({Package package, PlanPeriod period})>[];
  for (final PlanPeriod period in PlanPeriod.values) {
    for (final Package package in offering.availablePackages) {
      if (PlanPeriod.fromPackageType(package.packageType) == period) {
        found.add((package: package, period: period));
        break; // Only the first match per period, even if there are several.
      }
    }
  }

  // Show "best value" only when a per-month price exists for every plan; the
  // store sometimes omits pricePerMonth, and a gap means we say nothing.
  final Iterable<double?> perMonth = found.map(
    (({Package package, PlanPeriod period}) it) => it.package.storeProduct.pricePerMonth,
  );
  final bool comparable = found.length > 1 && !perMonth.contains(null);
  final double? cheapest = comparable
      ? perMonth.cast<double>().reduce((double a, double b) => a < b ? a : b)
      : null;

  return <SubscriptionPlan>[
    for (final ({Package package, PlanPeriod period}) it in found)
      SubscriptionPlan(
        package: it.package,
        period: it.period,
        isBestValue: cheapest != null && it.package.storeProduct.pricePerMonth == cheapest,
      ),
  ];
}

/// Picks one plan by period, falling back to the first (null when empty).
///
/// Kept in one place so the paywall's default selection and the line on the
/// celebration screen point at the same plan; choosing separately would let the
/// displayed price differ from the one actually bought.
SubscriptionPlan? planForPeriod(List<SubscriptionPlan> plans, PlanPeriod period) {
  if (plans.isEmpty) return null;
  for (final SubscriptionPlan plan in plans) {
    if (plan.period == period) return plan;
  }
  return plans.first;
}

/// Snapshot of billing state.
@immutable
class Entitlement {
  const Entitlement({
    required this.isPremium,
    this.offering,
    this.expiresAt,
    this.willRenew = false,
    this.isTrial = false,
    this.isSandbox = false,
    this.store,
    this.managementUrl,
  });

  /// Default for builds with the SDK unconfigured, so tests, CI and key-less
  /// builds keep running as free.
  static const Entitlement free = Entitlement(isPremium: false);

  /// Builds from CustomerInfo. If [entitlementId] does not match the
  /// dashboard, purchases succeed while nothing is unlocked.
  factory Entitlement.from({
    required CustomerInfo info,
    required String entitlementId,
    Offering? offering,
  }) {
    final EntitlementInfo? active = info.entitlements.active[entitlementId];
    return Entitlement(
      isPremium: active != null,
      offering: offering,
      expiresAt: _parseDate(active?.expirationDate),
      willRenew: active?.willRenew ?? false,
      // A trial means nothing has been paid yet; it changes how we say thanks.
      // Do not fold in intro (a paid intro offer) — that one is paid.
      isTrial: active?.periodType == PeriodType.trial,
      isSandbox: active?.isSandbox ?? false,
      store: active?.store,
      // URL to the store's cancellation screen; the escape hatch for when
      // Customer Center is unavailable.
      managementUrl: info.managementURL,
    );
  }

  final bool isPremium;

  /// The current Offering; used only when we draw the paywall ourselves.
  final Offering? offering;

  /// Expiry. Access lasts until this point even after cancelling.
  final DateTime? expiresAt;

  final bool willRenew;

  /// In a free trial: nothing has been billed yet.
  ///
  /// Ignoring this and saying "thank you for your purchase" would thank someone
  /// who has not paid anything.
  final bool isTrial;

  final bool isSandbox;
  final Store? store;
  final String? managementUrl;

  List<SubscriptionPlan> get plans => plansOf(offering);

  /// Cancelled but valid until expiry: what was paid for stays usable.
  /// Matches how the backend treats CANCELLATION.
  bool get isCancelled => isPremium && !willRenew;

  /// Days left until expiry, rounded up.
  ///
  /// Used for the trial heading ("all of it, for 7 days"). Rounding down can
  /// show "6 days left" right after purchase, when it is minutes short of 7.
  /// Returns 0 when nothing is left or the expiry is unknown.
  ///
  /// [now] is a parameter so tests can pin the clock.
  int daysLeft(DateTime now) {
    final DateTime? end = expiresAt;
    if (end == null) return 0;
    final Duration left = end.difference(now);
    if (left.isNegative) return 0;
    return (left.inMinutes / Duration.minutesPerDay).ceil();
  }

  /// Whether to show the manage-subscription entry: while subscribed, or when
  /// the store provides a cancellation URL.
  bool get canManageSubscription => isPremium || managementUrl != null;

  static DateTime? _parseDate(String? value) =>
      value == null ? null : DateTime.tryParse(value)?.toLocal();
}
