import 'package:flutter/foundation.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import 'onesignal_config.dart';

part 'onesignal_repository.g.dart';

/// OneSignal SDK の唯一の出入口(handoff §5 の Repository = SSOT)。
///
/// SDKは static メソッドの集まりなので、画面や Controller から直接呼ぶと
/// テストで差し替えられない。ここに閉じ込めて、テストでは
/// [oneSignalRepositoryProvider] ごと override する。
///
/// **ここ以外から `OneSignal.*` を呼ばないこと。**
class OneSignalRepository {
  const OneSignalRepository();

  /// 初期化済みかどうか。
  ///
  /// `main()` は ProviderScope の外で使い捨ての実体を作って [configure] を呼ぶので、
  /// インスタンス変数だと provider 側の実体と状態が共有されない。
  /// SDK側に「初期化済みか」を訊く口が無いため、ここで static に持つ。
  static bool _initialized = false;

  /// 起動時に一度だけ呼ぶ(`main()`)。
  ///
  /// [externalId] は匿名デバイスID。backend/api は
  /// `include_aliases: { external_id: [deviceId] }` で復習プッシュを撃つので
  /// (backend/api/src/lib/notifications.ts)、**ここで login しないと
  /// 予約は成功しているのに端末に一通も届かない。**
  Future<void> configure({required String externalId}) async {
    if (!OneSignalConfig.isConfigured) return;
    if (_initialized) return;
    _initialized = true;

    // 通知の不具合は「届かない」としか観測できず、ログが無いと追えない。
    // リリースでも info は残す。
    await OneSignal.Debug.setLogLevel(kDebugMode ? OSLogLevel.verbose : OSLogLevel.info);

    await OneSignal.initialize(OneSignalConfig.appId);
    await login(externalId);
  }

  /// external_id を紐づける。アカウントは作らないのでデバイスIDをそのまま使う。
  Future<void> login(String externalId) => OneSignal.login(externalId);

  Future<void> logout() => OneSignal.logout();

  Future<void> addTag(String key, String value) =>
      OneSignal.User.addTagWithKey(key, value);

  Future<void> addEmail(String email) => OneSignal.User.addEmail(email);

  Future<void> addSms(String smsNumber) => OneSignal.User.addSms(smsNumber);

  Future<void> setLogLevel(OSLogLevel level) => OneSignal.Debug.setLogLevel(level);

  /// 通知の許可を求める。
  ///
  /// **呼ぶ場所は1箇所だけ**(登録確認ダイアログの「Got it」)。
  /// 起動直後に出すと、何のアプリか分からないまま拒否されて二度と出せない。
  /// [fallbackToSettings] は、一度拒否された端末で設定アプリへ誘導するため。
  Future<bool> requestPermission({bool fallbackToSettings = true}) =>
      OneSignal.Notifications.requestPermission(fallbackToSettings);

  /// いま端末に割り当たっている購読ID。まだなら null。
  String? get pushSubscriptionId => OneSignal.User.pushSubscription.id;

  void addPushSubscriptionObserver(OnPushSubscriptionChangeObserver observer) =>
      OneSignal.User.pushSubscription.addObserver(observer);

  void removePushSubscriptionObserver(OnPushSubscriptionChangeObserver observer) =>
      OneSignal.User.pushSubscription.removeObserver(observer);

  /// サーバから本物の購読IDが降りてきたか。
  ///
  /// SDKは初期化直後に `local-...` という仮のIDを入れる。これは
  /// 「まだ登録できていない」状態なので、登録済みと数えてはいけない。
  static bool isRegistered(String? subscriptionId) =>
      subscriptionId != null &&
      subscriptionId.isNotEmpty &&
      !subscriptionId.startsWith('local-');
}

@Riverpod(keepAlive: true)
OneSignalRepository oneSignalRepository(Ref ref) => const OneSignalRepository();
