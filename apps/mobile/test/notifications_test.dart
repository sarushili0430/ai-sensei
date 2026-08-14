import 'package:ai_sensei/src/features/notifications/data/push_repository.dart';
import 'package:flutter_test/flutter_test.dart';

/// Pure unit tests for push.
///
/// They check not whether notifications arrive but whether we misread the
/// registration verdict. A misread produces "we recorded it as registered and
/// not a single one is delivered", which is invisible locally.
void main() {
  group('設定', () {
    test('App ID を渡さないビルドでは通知ごと無効になる', () {
      // If this flipped true, unrelated screens (the karte toggle) would render
      // differently and take goldens down with them. Hence no default value.
      expect(PushConfig.appId, isEmpty);
      expect(PushConfig.isConfigured, isFalse);
    });
  });

  group('端末が登録できたかの判定', () {
    test('サーバが払い出したIDなら登録済み', () {
      expect(
        PushRepository.isRegistered('a8f3c1de-2b47-4e09-9d61-77c2b0e5a134'),
        isTrue,
      );
    });

    test('local- で始まる仮のIDは登録済みにしない', () {
      // The SDK stores this placeholder right after init. Counting it as
      // registered decides success before the device reaches OneSignal.
      expect(PushRepository.isRegistered('local-abc123'), isFalse);
    });

    test('未割り当て(null)と空文字は登録済みにしない', () {
      expect(PushRepository.isRegistered(null), isFalse);
      expect(PushRepository.isRegistered(''), isFalse);
    });
  });
}
