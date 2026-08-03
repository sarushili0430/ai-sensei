import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

part 'device_id.g.dart';

/// 匿名デバイスID(handoff §5)。
///
/// アカウント作成を要求しないので、初回起動時にUUIDを作って保存するだけ。
/// これでApp Reviewの「アカウント削除」要件も回避できる。
const String _deviceIdKey = 'ai_sensei.device_id';

Future<String> loadOrCreateDeviceId(SharedPreferences preferences) async {
  final String? existing = preferences.getString(_deviceIdKey);
  if (existing != null && existing.isNotEmpty) return existing;

  final String created = const Uuid().v4();
  await preferences.setString(_deviceIdKey, created);
  return created;
}

/// main() でoverrideする。起動時に確定しているので同期で読める。
@Riverpod(keepAlive: true)
String deviceId(Ref ref) {
  throw UnimplementedError('deviceIdProvider は main() で override してください');
}

const String _onboardedKey = 'ai_sensei.onboarded';

Future<bool> hasSeenOnboarding(SharedPreferences preferences) async =>
    preferences.getBool(_onboardedKey) ?? false;

Future<void> markOnboardingSeen(SharedPreferences preferences) =>
    preferences.setBool(_onboardedKey, true);

/// 初回起動かどうか。main() でoverrideする。
@Riverpod(keepAlive: true)
bool onboarded(Ref ref) => true;

/// オンボーディングの既読を書き込むために持つ。main() でoverrideする。
@Riverpod(keepAlive: true)
SharedPreferences preferences(Ref ref) {
  throw UnimplementedError('preferencesProvider は main() で override してください');
}
