import 'package:flutter/foundation.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';

/// OneSignal の設定値。`--dart-define` から読む。
///
/// App ID は公開値(受信端末を特定するだけの識別子)。
/// REST API Key は backend/api 側にあり、ここには置かない。
abstract final class PushConfig {
  /// OneSignal ダッシュボードの App ID(`47044c5e-…`)。
  ///
  /// **ここに既定値を持たせてはいけない。** 値が入ると `isConfigured` が
  /// テストでも true になり、カルテ画面の通知トグルが出て golden が動く。
  /// 実ビルドに値を届けるのは呼び出し側の役目:
  ///   - 手元 … `dart_defines.env`(`dart_defines.example.env` に記載)
  ///   - CI  … `codemagic.yaml` の `--dart-define=ONESIGNAL_APP_ID=...`
  static const String appId = String.fromEnvironment('ONESIGNAL_APP_ID');

  /// App ID の無いビルド(`flutter test` / CI / 渡し忘れ)では通知ごと無効にする。
  /// ここで落とすと、通知と関係ない画面のテストまで巻き添えになる。
  static bool get isConfigured => appId.isNotEmpty;
}

/// プッシュ通知(OneSignal)。
///
/// このアプリの再訪はぜんぶ通知が起点なので、ここが繋がっていないと
/// 「翌日・3日後・7日後に後輩がもう一度たずねてくる」が実機で成立しない。
///
/// サーバは `include_aliases.external_id = [deviceId]` で宛先を指定している
/// (`backend/api/src/lib/notifications.ts`)。なので **login(deviceId) は必須**。
/// これを呼ばないと予約は通るのに1通も届かない。
class PushRepository {
  const PushRepository();

  /// 起動時に一度だけ。**許可はここでは求めない**(文脈内で聞く)。
  Future<void> configure({required String deviceId}) async {
    if (!PushConfig.isConfigured) return;
    OneSignal.initialize(PushConfig.appId);
    await OneSignal.login(deviceId);
  }

  /// いま通知を受け取れるか。許可を求めずに状態だけ見る。
  bool get hasPermission => PushConfig.isConfigured && OneSignal.Notifications.permission;

  /// 許可を求める。カルテで穴が見えた直後にだけ呼ぶ。
  ///
  /// iOS はシステムダイアログを一度しか出せない。一度断られたあとは
  /// `fallbackToSettings: true` で設定アプリに案内する
  /// (アプリ内で何度もダイアログを出そうとしても、二度と出ない)。
  Future<bool> requestPermission() async {
    if (!PushConfig.isConfigured) return false;
    return OneSignal.Notifications.requestPermission(true);
  }

  /// いま端末に割り当たっている購読ID。まだなら null。
  String? get pushSubscriptionId =>
      PushConfig.isConfigured ? OneSignal.User.pushSubscription.id : null;

  void addPushSubscriptionObserver(OnPushSubscriptionChangeObserver observer) {
    if (!PushConfig.isConfigured) return;
    OneSignal.User.pushSubscription.addObserver(observer);
  }

  void removePushSubscriptionObserver(OnPushSubscriptionChangeObserver observer) {
    if (!PushConfig.isConfigured) return;
    OneSignal.User.pushSubscription.removeObserver(observer);
  }

  /// サーバから本物の購読IDが降りてきたか。
  ///
  /// SDKは初期化直後に `local-...` という仮のIDを入れる。これは
  /// 「まだ登録できていない」状態なので、登録済みと数えてはいけない。
  static bool isRegistered(String? subscriptionId) =>
      subscriptionId != null &&
      subscriptionId.isNotEmpty &&
      !subscriptionId.startsWith('local-');

  /// 通知タップの着地先を受け取る。
  ///
  /// サーバは `data: { hole_id, step }` を積んでいる。いまは穴の指定までは見ず、
  /// 復習画面まで運ぶ(そこに同じ穴がカードで出ている)。
  void onOpened(void Function(String? holeId) handler) {
    if (!PushConfig.isConfigured) return;
    OneSignal.Notifications.addClickListener((OSNotificationClickEvent event) {
      final Map<String, dynamic>? data = event.notification.additionalData;
      handler(data?['hole_id'] as String?);
    });
  }
}

/// 通知の許可状態。画面に出すのはトグルの on/off だけ。
@immutable
class PushPermission {
  const PushPermission({required this.granted, required this.available});

  /// 許可されている。
  final bool granted;

  /// そもそも通知を扱えるビルドか(App ID が渡っているか)。
  final bool available;

  static const PushPermission unavailable =
      PushPermission(granted: false, available: false);
}
