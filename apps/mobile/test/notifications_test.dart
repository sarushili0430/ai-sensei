import 'package:ai_sensei/src/features/notifications/data/push_repository.dart';
import 'package:flutter_test/flutter_test.dart';

/// プッシュまわりの純関数ユニット(テスト方針①)。
///
/// 見ているのは「通知が届くか」ではなく、**登録できたかどうかの判定を
/// こちらが取り違えていないか**。取り違えると「登録できたことにしたのに、
/// 実際には一通も届かない」という、手元では気づけない壊れ方をする。
void main() {
  group('設定', () {
    test('App ID を渡さないビルドでは通知ごと無効になる', () {
      // ここが true に転ぶと、通知と関係ない画面(カルテのトグル)まで
      // 描画が変わって golden が巻き添えで落ちる。既定値を持たせない理由。
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
      // SDKは初期化直後にこの仮IDを入れる。ここを登録済みと数えると、
      // 端末がOneSignalに載る前に「登録できた」と判断してしまう。
      expect(PushRepository.isRegistered('local-abc123'), isFalse);
    });

    test('未割り当て(null)と空文字は登録済みにしない', () {
      expect(PushRepository.isRegistered(null), isFalse);
      expect(PushRepository.isRegistered(''), isFalse);
    });
  });
}
