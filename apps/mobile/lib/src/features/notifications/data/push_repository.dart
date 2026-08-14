import 'package:flutter/foundation.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';

/// OneSignal configuration, read from `--dart-define`.
///
/// The App ID is public (it only identifies receiving devices). The REST API
/// key lives in backend/api and never here.
abstract final class PushConfig {
  /// App ID from the OneSignal dashboard (`47044c5e-…`).
  ///
  /// Must have no default: a value makes `isConfigured` true in tests too,
  /// which shows the karte notification toggle and shifts goldens. Delivering
  /// it to real builds is the caller's job:
  ///   - local … `dart_defines.env` (documented in `dart_defines.example.env`)
  ///   - CI    … `--dart-define=ONESIGNAL_APP_ID=...` in `codemagic.yaml`
  static const String appId = String.fromEnvironment('ONESIGNAL_APP_ID');

  /// Builds without an App ID (`flutter test`, CI, a forgotten flag) disable
  /// notifications entirely; failing here would take unrelated screen tests
  /// down with it.
  static bool get isConfigured => appId.isNotEmpty;
}

/// Push notifications (OneSignal).
///
/// Every return visit starts from a notification, so without this wired up
/// "senpai asks again tomorrow, in 3 days, in 7 days" never happens on device.
///
/// The server addresses by `include_aliases.external_id = [deviceId]`
/// (`backend/api/src/lib/notifications.ts`), so `login(deviceId)` is
/// mandatory — skip it and scheduling succeeds while nothing is delivered.
class PushRepository {
  const PushRepository();

  /// Once at startup. Does not request permission — that happens in context.
  Future<void> configure({required String deviceId}) async {
    if (!PushConfig.isConfigured) return;
    OneSignal.initialize(PushConfig.appId);

    // No location data: nothing here varies by geography. Set explicitly
    // rather than trusting the SDK default, since a changed default would go
    // unnoticed (as happened with Sentry's `enablePrintBreadcrumbs`).
    //
    // Users are minors and notifications only need timing. Do not call
    // `requestPermission()` — it prompts for location.
    await OneSignal.Location.setShared(false);

    await OneSignal.login(deviceId);
  }

  /// Whether notifications can be received; reads state without prompting.
  bool get hasPermission => PushConfig.isConfigured && OneSignal.Notifications.permission;

  /// Requests permission; called only just after a gap appears in the karte.
  ///
  /// iOS shows the system dialog once. After a refusal,
  /// `fallbackToSettings: true` routes to the Settings app — retrying in-app
  /// never shows the dialog again.
  Future<bool> requestPermission() async {
    if (!PushConfig.isConfigured) return false;
    return OneSignal.Notifications.requestPermission(true);
  }

  /// The subscription ID currently assigned to this device; null if none yet.
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

  /// Whether a real subscription ID has arrived from the server.
  ///
  /// Right after init the SDK stores a placeholder `local-...` ID, which means
  /// "not registered yet" and must not count as registered.
  static bool isRegistered(String? subscriptionId) =>
      subscriptionId != null &&
      subscriptionId.isNotEmpty &&
      !subscriptionId.startsWith('local-');

  /// Receives the landing target for a notification tap.
  ///
  /// The server attaches `data: { hole_id, step }`. We ignore the specific gap
  /// for now and route to review, where the same gap appears as a card.
  void onOpened(void Function(String? holeId) handler) {
    if (!PushConfig.isConfigured) return;
    OneSignal.Notifications.addClickListener((OSNotificationClickEvent event) {
      final Map<String, dynamic>? data = event.notification.additionalData;
      handler(data?['hole_id'] as String?);
    });
  }
}

/// Notification permission state; the UI shows only the toggle's on/off.
@immutable
class PushPermission {
  const PushPermission({required this.granted, required this.available});

  /// Permission granted.
  final bool granted;

  /// Whether this build can handle notifications at all (App ID present).
  final bool available;

  static const PushPermission unavailable =
      PushPermission(granted: false, available: false);
}
