import 'package:flutter/services.dart';
import 'package:purchases_flutter/errors.dart';

/// Result of a purchase or restore.
///
/// The SDK throws [PlatformException] on failure. Passing that straight to the
/// UI would report a user's own cancellation as an error, so this splits it
/// into cancelled / failed / succeeded first.

/// Message categories for the UI: the SDK's ~40 error codes grouped by what
/// the user can do next.
enum PurchaseFailure {
  /// No connectivity. Retrying later works.
  network,

  /// A store-side problem we cannot fix.
  storeProblem,

  /// Blocked by device settings or parental controls.
  notAllowed,

  /// Already owned; restoring unlocks it.
  alreadyOwned,

  /// Payment pending (convenience-store payment and the like); the entitlement
  /// follows on approval.
  pending,

  /// Dashboard and app configuration disagree — should be caught in dev.
  configuration,

  unknown;

  static PurchaseFailure fromErrorCode(PurchasesErrorCode code) => switch (code) {
    PurchasesErrorCode.networkError ||
    PurchasesErrorCode.offlineConnectionError ||
    PurchasesErrorCode.productRequestTimeout ||
    PurchasesErrorCode.apiEndpointBlocked => PurchaseFailure.network,

    PurchasesErrorCode.storeProblemError ||
    PurchasesErrorCode.unexpectedBackendResponseError ||
    PurchasesErrorCode.unknownBackendError ||
    PurchasesErrorCode.invalidReceiptError ||
    PurchasesErrorCode.missingReceiptFileError => PurchaseFailure.storeProblem,

    PurchasesErrorCode.purchaseNotAllowedError ||
    PurchasesErrorCode.purchaseInvalidError ||
    PurchasesErrorCode.ineligibleError => PurchaseFailure.notAllowed,

    PurchasesErrorCode.productAlreadyPurchasedError ||
    PurchasesErrorCode.receiptAlreadyInUseError ||
    PurchasesErrorCode.receiptInUseByOtherSubscriberError ||
    PurchasesErrorCode.purchaseBelongsToOtherUser => PurchaseFailure.alreadyOwned,

    PurchasesErrorCode.paymentPendingError => PurchaseFailure.pending,

    // Wrong product ID, wrong entitlement or swapped keys. This means a bug, so
    // the user-facing wording says "configuration problem" honestly.
    PurchasesErrorCode.configurationError ||
    PurchasesErrorCode.invalidCredentialsError ||
    PurchasesErrorCode.invalidAppleSubscriptionKeyError ||
    PurchasesErrorCode.productNotAvailableForPurchaseError ||
    PurchasesErrorCode.unsupportedError => PurchaseFailure.configuration,

    _ => PurchaseFailure.unknown,
  };
}

sealed class PurchaseOutcome {
  const PurchaseOutcome();

  /// Converts an exception to a result; cancellation stops being a failure here.
  factory PurchaseOutcome.fromException(PlatformException error) {
    final PurchasesErrorCode code = PurchasesErrorHelper.getErrorCode(error);
    // The user simply closed it: no error UI, no failure in analytics.
    if (code == PurchasesErrorCode.purchaseCancelledError) {
      return const PurchaseCancelled();
    }
    return PurchaseFailed(PurchaseFailure.fromErrorCode(code));
  }
}

/// The purchase went through and the entitlement was granted.
final class PurchaseSucceeded extends PurchaseOutcome {
  const PurchaseSucceeded();
}

/// The purchase went through but no entitlement was granted.
///
/// Almost always the product is not attached to the Entitlement in the
/// dashboard. Closing as success would mean "paid but unusable", so it is a
/// separate case.
final class PurchaseNotEntitled extends PurchaseOutcome {
  const PurchaseNotEntitled();
}

final class PurchaseCancelled extends PurchaseOutcome {
  const PurchaseCancelled();
}

final class PurchaseFailed extends PurchaseOutcome {
  const PurchaseFailed(this.failure);

  final PurchaseFailure failure;
}

/// Restore result. "Nothing to restore" is not a failure, so it is separate.
sealed class RestoreOutcome {
  const RestoreOutcome();

  factory RestoreOutcome.fromException(PlatformException error) =>
      RestoreFailed(PurchaseFailure.fromErrorCode(PurchasesErrorHelper.getErrorCode(error)));
}

final class RestoreSucceeded extends RestoreOutcome {
  const RestoreSucceeded();
}

/// The request succeeded but this Apple ID / Google account had no purchases.
final class RestoreFoundNothing extends RestoreOutcome {
  const RestoreFoundNothing();
}

final class RestoreFailed extends RestoreOutcome {
  const RestoreFailed(this.failure);

  final PurchaseFailure failure;
}
