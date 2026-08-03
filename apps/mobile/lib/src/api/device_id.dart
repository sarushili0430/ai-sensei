import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

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
final Provider<String> deviceIdProvider = Provider<String>((Ref ref) {
  throw UnimplementedError('deviceIdProvider は main() で override してください');
});

const String _onboardedKey = 'ai_sensei.onboarded';

Future<bool> hasSeenOnboarding(SharedPreferences preferences) async =>
    preferences.getBool(_onboardedKey) ?? false;

Future<void> markOnboardingSeen(SharedPreferences preferences) =>
    preferences.setBool(_onboardedKey, true);

/// 初回起動かどうか。main() でoverrideする。
final Provider<bool> onboardedProvider = Provider<bool>((Ref ref) => true);

/// オンボーディングを見せたあと、以後スキップするためのフラグ書き込み。
final Provider<SharedPreferences> preferencesProvider = Provider<SharedPreferences>((Ref ref) {
  throw UnimplementedError('preferencesProvider は main() で override してください');
});
