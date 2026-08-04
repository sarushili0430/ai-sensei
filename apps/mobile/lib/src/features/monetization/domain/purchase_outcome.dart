import 'package:flutter/services.dart';
import 'package:purchases_flutter/errors.dart';

/// 購入・復元の結果。
///
/// SDKは失敗を [PlatformException] で投げてくる。そのまま画面に流すと
/// 「ユーザーが自分でやめた」ことまでエラーとして出てしまうので、
/// ここで **キャンセル / 失敗 / 成功** の3つに分けてから返す。

/// 画面に出す文言の分類。SDKの40種類のエラーコードを、
/// 「利用者が次に取れる行動」でまとめたもの。
enum PurchaseFailure {
  /// 通信が届いていない。時間をおけば直る。
  network,

  /// ストア側の問題。こちらでは直せない。
  storeProblem,

  /// 端末の設定やペアレンタルコントロールで購入できない。
  notAllowed,

  /// すでに持っている。復元すれば解放される。
  alreadyOwned,

  /// 決済が保留中(コンビニ払いなど)。承認されると entitlement が付く。
  pending,

  /// ダッシュボードとアプリの設定がずれている。**開発時に気づくべき**もの。
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

    // 商品IDやEntitlementの取り違え、鍵の入れ違い。
    // 出たら実装ミスなので、利用者向けの文言も「設定の問題」と正直に書く。
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

  /// 例外を結果に変換する。キャンセルはここで失敗から外れる。
  factory PurchaseOutcome.fromException(PlatformException error) {
    final PurchasesErrorCode code = PurchasesErrorHelper.getErrorCode(error);
    // 利用者が自分で閉じただけ。エラー表示も分析上の失敗も出さない。
    if (code == PurchasesErrorCode.purchaseCancelledError) {
      return const PurchaseCancelled();
    }
    return PurchaseFailed(PurchaseFailure.fromErrorCode(code));
  }
}

/// 購入が通り、entitlement も付いた。
final class PurchaseSucceeded extends PurchaseOutcome {
  const PurchaseSucceeded();
}

/// 購入は通ったが entitlement が付いていない。
///
/// ほぼ確実に **ダッシュボードで商品が Entitlement に紐づいていない**。
/// 成功として画面を閉じると「課金したのに使えない」になるので分けている。
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

/// 復元の結果。「復元するものが無かった」は失敗ではないので分ける。
sealed class RestoreOutcome {
  const RestoreOutcome();

  factory RestoreOutcome.fromException(PlatformException error) =>
      RestoreFailed(PurchaseFailure.fromErrorCode(PurchasesErrorHelper.getErrorCode(error)));
}

final class RestoreSucceeded extends RestoreOutcome {
  const RestoreSucceeded();
}

/// 通信は成功したが、この Apple ID / Google アカウントに購入が無かった。
final class RestoreFoundNothing extends RestoreOutcome {
  const RestoreFoundNothing();
}

final class RestoreFailed extends RestoreOutcome {
  const RestoreFailed(this.failure);

  final PurchaseFailure failure;
}
