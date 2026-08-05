/// OneSignal の設定値。`--dart-define` から読む。
///
/// App ID は**公開値**(ダッシュボードのURLにも出るし、アプリを解析すれば
/// 誰でも読める)なので、ここに既定値として置いてある。これで鍵を渡し忘れた
/// ビルドでもプッシュが素通しにならない。
///
/// **REST API Key はここに置かない。** あれは送信用の秘密鍵で、
/// 持っていれば誰にでも通知を撃てる。サーバ側(backend/api)にあり、
/// `pnpm run verify:secrets` が混入を見張っている。
///
/// 値は `apps/mobile/dart_defines.env` にまとめて置き、
/// `--dart-define-from-file=dart_defines.env` で渡す。
abstract final class OneSignalConfig {
  /// OneSignal ダッシュボードの App ID。
  ///
  /// backend/api 側の `ONESIGNAL_APP_ID` と**同じ値**でなければ、
  /// アプリは登録できているのにサーバからの予約が別アプリ宛になる。
  static const String appId = String.fromEnvironment(
    'ONESIGNAL_APP_ID',
    defaultValue: '47044c5e-15eb-49ec-bdd4-e0ed2219a799',
  );

  /// App ID の無いビルド(`flutter test` / 明示的に空を渡した場合)では、
  /// 通知だけ黙って無効にして起動する。
  /// ここで落とすと、通知と関係ない画面のテストまで巻き添えになる。
  static bool get isConfigured => appId.isNotEmpty;
}
