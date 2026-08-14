import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/device_id.dart';
import '../../../routing/routes.dart';
import '../data/push_repository.dart';

part 'push_controller.g.dart';

@Riverpod(keepAlive: true)
PushRepository pushRepository(Ref ref) => const PushRepository();

/// Notification wiring, started by a single watch from `AiSenseiApp`.
///
/// It initializes the SDK, registers the external id (the anonymous device ID)
/// used for addressing, and hooks up tap handling. No permission prompt here —
/// that happens in context.
@Riverpod(keepAlive: true)
class PushSetup extends _$PushSetup {
  @override
  Future<void> build() async {
    final PushRepository repository = ref.read(pushRepositoryProvider);
    await repository.configure(deviceId: ref.read(deviceIdProvider));
    repository.onOpened((String? holeId) {
      // The specific gap is ignored; review shows the same gap as a card.
      ref.read(pendingDeepLinkProvider.notifier).set(AppRoute.review.path);
    });
  }
}

/// Notification permission state.
///
/// Permission is requested from exactly one place: the karte toggle. Never on
/// first launch. Asking right after a gap is found has real context and fits
/// the promise not to nag.
///
/// The senpai framing makes this land better than the junior one did: a request
/// from someone who could simply assert makes it unmistakable that permission
/// is being asked for, not assumed.
@Riverpod(keepAlive: true)
class PushPermissionController extends _$PushPermissionController {
  @override
  PushPermission build() {
    if (!PushConfig.isConfigured) return PushPermission.unavailable;
    return PushPermission(
      granted: ref.read(pushRepositoryProvider).hasPermission,
      available: true,
    );
  }

  /// Requests permission. On refusal the state is unchanged (toggle reverts).
  Future<bool> request() async {
    final bool granted = await ref.read(pushRepositoryProvider).requestPermission();
    state = PushPermission(granted: granted, available: PushConfig.isConfigured);
    return granted;
  }
}

/// Landing target for a notification tap.
///
/// On a cold start the click can arrive before the app is up, so it is parked
/// here instead of navigating immediately, then carried once the widget tree
/// exists.
@Riverpod(keepAlive: true)
class PendingDeepLink extends _$PendingDeepLink {
  @override
  String? build() => null;

  void set(String path) => state = path;

  /// Cleared once delivered, so going back does not drag you in again.
  String? take() {
    final String? path = state;
    state = null;
    return path;
  }
}
