import '../../../l10n/strings.dart';
import '../domain/purchase_outcome.dart';

/// 失敗の分類を文言にする。
///
/// 「エラーが発生しました」で済ませない。何が起きていて、次に何をすれば
/// いいかを書く。ここも先輩の口調(煽らない・責めない)に合わせる。
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
