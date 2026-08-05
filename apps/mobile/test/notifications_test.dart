import 'package:ai_sensei/src/features/notifications/data/onesignal_config.dart';
import 'package:ai_sensei/src/features/notifications/data/onesignal_repository.dart';
import 'package:flutter_test/flutter_test.dart';

/// プッシュまわりの純関数ユニット(テスト方針①)。
///
/// 見ているのは「通知が届くか」ではなく、**登録できたかどうかの判定を
/// こちらが取り違えていないか**。取り違えると「登録できたことにして
/// 確認ダイアログを出したのに、実際には一通も届かない」という、
/// 手元では気づけない壊れ方をする。
void main() {
  group('設定', () {
    test('App ID の既定値が入っている(鍵を渡し忘れても素通しにしない)', () {
      expect(OneSignalConfig.appId, '47044c5e-15eb-49ec-bdd4-e0ed2219a799');
      expect(OneSignalConfig.isConfigured, isTrue);
    });
  });

  group('端末が登録できたかの判定', () {
    test('サーバが払い出したIDなら登録済み', () {
      expect(
        OneSignalRepository.isRegistered('a8f3c1de-2b47-4e09-9d61-77c2b0e5a134'),
        isTrue,
      );
    });

    test('local- で始まる仮のIDは登録済みにしない', () {
      // SDKは初期化直後にこの仮IDを入れる。ここを登録済みと数えると、
      // 端末がOneSignalに載る前に確認ダイアログが出てしまう。
      expect(OneSignalRepository.isRegistered('local-abc123'), isFalse);
    });

    test('未割り当て(null)と空文字は登録済みにしない', () {
      expect(OneSignalRepository.isRegistered(null), isFalse);
      expect(OneSignalRepository.isRegistered(''), isFalse);
    });
  });
}
