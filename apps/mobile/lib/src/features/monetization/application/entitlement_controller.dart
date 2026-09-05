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

/// RevenueCat の entitlement。
///
/// 参加の絶対条件(RevenueCat SDKで最低1つのアプリ内課金)を満たす箇所。
/// **サーバ側の判定が正**で、ここはUIの出し分けにだけ使う。
/// クライアントの申告でセッション上限を緩めることはしない。
///
/// SDKの初期化は `main()` の [PurchasesRepository.configure] で済ませてある。
/// この Controller は「今の状態を読む」ことと「購入・復元を投げる」ことだけ持つ。
@Riverpod(keepAlive: true)
class EntitlementController extends _$EntitlementController {
  @override
  Future<Entitlement> build() async {
    // 鍵の無いビルドでは課金機能ごと無効。エラーにはしない
    // (課金と関係ない画面のテストを巻き添えにしないため)。
    if (!RevenueCatConfig.isConfigured) return Entitlement.free;

    final PurchasesRepository repository = ref.watch(purchasesRepositoryProvider);

    // 更新・失効・ペイウォール内での購入・Customer Center での解約を
    // SDK が push してくる。画面を開き直さなくても状態が追いつく。
    final StreamSubscription<CustomerInfo> subscription = repository
        .customerInfoChanges()
        .listen(_onCustomerInfo, onError: (Object _) {});
    ref.onDispose(subscription.cancel);

    return _read(repository);
  }

  Future<Entitlement> _read(PurchasesRepository repository) async {
    // Offering の取得はネットワーク越しで、落ちることがある。
    // ペイウォールは出せなくても entitlement の判定は生かしたいので、
    // ここだけは失敗を握りつぶして null にする。
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
        // Offering は CustomerInfo の更新では変わらない。直前のものを保つ。
        offering: state.value?.offering,
      ),
    );
  }

  /// ダッシュボードとアプリの設定ずれを、開発中に気づけるようにする。
  ///
  /// この2つは「課金は通るのに何も起きない」というもっとも気づきにくい
  /// 壊れ方をするので、releaseビルドでもログには残す。
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

  /// 購入する。
  ///
  /// キャンセルは失敗として扱わない。SDKは利用者が閉じた場合も例外を
  /// 投げてくるので、[PurchaseOutcome] に畳んでから返している。
  Future<PurchaseOutcome> purchase(Package package) async {
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    final Entitlement previous = state.value ?? Entitlement.free;

    // Riverpod 3 の AsyncNotifier は loading にしても直前の値を保つので、
    // 購入中もペイウォールの価格表示は消えない
    // (`state.value` は previous のまま読める)。
    state = const AsyncValue<Entitlement>.loading();
    try {
      final CustomerInfo info = await repository.purchase(package);
      final Entitlement next = Entitlement.from(
        info: info,
        entitlementId: RevenueCatConfig.entitlementId,
        offering: previous.offering,
      );
      state = AsyncValue<Entitlement>.data(next);

      // 決済は通ったのに entitlement が付いていない = ダッシュボードで
      // 商品が Entitlement に紐づいていない。成功として閉じてはいけない。
      return next.isPremium ? const PurchaseSucceeded() : const PurchaseNotEntitled();
    } on PlatformException catch (error) {
      state = AsyncValue<Entitlement>.data(previous);
      return PurchaseOutcome.fromException(error);
    }
  }

  /// 復元。App Review の必須要件。
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
      // 通信は成功したが購入が無かった場合と、復元できた場合を分ける。
      // どちらも成功なので、区別せずに「失敗しました」とは出さない。
      return next.isPremium ? const RestoreSucceeded() : const RestoreFoundNothing();
    } on PlatformException catch (error) {
      state = AsyncValue<Entitlement>.data(previous);
      return RestoreOutcome.fromException(error);
    }
  }

  /// Offering が確定するまで待つ。
  ///
  /// ペイウォールを出す直前に呼ぶ。`REVENUECAT_OFFERING_ID` を指定していても
  /// 取りこぼさないため。取れなくても RevenueCat 側が current で出すので、
  /// 失敗はここで握りつぶす。
  Future<Offering?> _resolvedOffering() async {
    try {
      return (await future).offering;
    } on Object {
      return null;
    }
  }

  /// RevenueCat のペイウォールを出す。
  ///
  /// 返り値が [PaywallResult.error] のときは、ダッシュボードに
  /// ペイウォールが無いか、OSのバージョンが足りていない。
  /// 呼び出し側は自前のペイウォールに切り替えること。
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

  /// 未契約のときだけペイウォールを出す。機能を触った瞬間の出し分けに使う。
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

  /// Customer Center を出す。解約・返金申請・プラン変更・復元がここに入っている。
  ///
  /// 出せたら true。SDK未設定やOSが古い場合は false を返すので、
  /// 呼び出し側はストアの解約URLへ逃がすこと。
  Future<bool> presentCustomerCenter() async {
    if (!RevenueCatConfig.isConfigured) return false;
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    try {
      await repository.presentCustomerCenter(onRestoreCompleted: _onCustomerInfo);
      // 解約は CustomerInfo の push で拾えないことがある(期限まで有効なので
      // entitlement 自体は変わらない)。閉じたあとに読み直す。
      await refresh();
      return true;
    } on PlatformException catch (error) {
      debugPrint('RevenueCat: Customer Center を出せませんでした: $error');
      return false;
    }
  }

  /// 最新の状態を読み直す。
  Future<void> refresh() async {
    if (!RevenueCatConfig.isConfigured) return;
    final PurchasesRepository repository = ref.read(purchasesRepositoryProvider);
    state = await AsyncValue.guard(() => _read(repository));
  }
}

/// entitlement を持っているか。画面から使うのはたいていこちら。
///
/// 読み込み中とエラーは「まだ持っていない」に倒す。
/// 判定が付かないあいだにPremium扱いすると、無料のまま使えてしまう。
@Riverpod(keepAlive: true)
bool isPremium(Ref ref) =>
    ref.watch(entitlementControllerProvider).value?.isPremium ?? false;
