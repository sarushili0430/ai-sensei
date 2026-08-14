import '../../../l10n/strings.dart';
import '../domain/entitlement.dart';
import '../domain/purchase_outcome.dart';

/// Plan period names, kept in one place so the paywall card and the line on
/// the celebration screen word it identically.
extension PlanPeriodLabel on PlanPeriod {
  String label(AppStrings strings) => switch (this) {
    PlanPeriod.weekly => strings.planWeekly,
    PlanPeriod.monthly => strings.planMonthly,
    PlanPeriod.yearly => strings.planYearly,
  };
}

/// Turns a failure category into wording.
///
/// Never just "an error occurred": say what happened and what to do next, in
/// senpai's voice — no nagging, no blame.
extension PurchaseFailureMessage on PurchaseFailure {
  String message(AppStrings strings) => switch (this) {
    PurchaseFailure.network => strings.purchaseErrorNetwork,
    PurchaseFailure.storeProblem => strings.purchaseErrorStore,
    PurchaseFailure.notAllowed => strings.purchaseErrorNotAllowed,
    PurchaseFailure.alreadyOwned => strings.purchaseErrorAlreadyOwned,
    PurchaseFailure.pending => strings.purchaseErrorPending,
    PurchaseFailure.configuration => strings.purchaseErrorConfiguration,
    PurchaseFailure.unknown => strings.errorGeneric,
  };
}
