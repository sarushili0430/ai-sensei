import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

part 'device_id.g.dart';

/// Anonymous device ID. No account is required, so first launch just mints
/// and stores a UUID — which also sidesteps App Review's account-deletion
/// requirement.
const String _deviceIdKey = 'ai_sensei.device_id';

Future<String> loadOrCreateDeviceId(SharedPreferences preferences) async {
  final String? existing = preferences.getString(_deviceIdKey);
  if (existing != null && existing.isNotEmpty) return existing;

  final String created = const Uuid().v4();
  await preferences.setString(_deviceIdKey, created);
  return created;
}

/// Overridden in main(); resolved at startup, so it reads synchronously.
@Riverpod(keepAlive: true)
String deviceId(Ref ref) {
  throw UnimplementedError('deviceIdProvider は main() で override してください');
}

const String _onboardedKey = 'ai_sensei.onboarded';

Future<bool> hasSeenOnboarding(SharedPreferences preferences) async =>
    preferences.getBool(_onboardedKey) ?? false;

Future<void> markOnboardingSeen(SharedPreferences preferences) =>
    preferences.setBool(_onboardedKey, true);

/// Whether this is the first launch. Overridden in main().
///
/// The default is deliberately not `true` (already onboarded): if the
/// override is ever lost, failing that way would silently skip onboarding
/// and start the app without ever showing the promise.
@Riverpod(keepAlive: true)
bool onboarded(Ref ref) => false;

/// Held so onboarding completion can be persisted. Overridden in main().
@Riverpod(keepAlive: true)
SharedPreferences preferences(Ref ref) {
  throw UnimplementedError('preferencesProvider は main() で override してください');
}
