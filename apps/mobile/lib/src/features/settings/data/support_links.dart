/// 設定画面から外に出るリンク。すべて `--dart-define` から読む。
///
/// 値を空にできるようにしてあるのは、鍵と同じでリポジトリに実在しない値を
/// 埋めたくないから。**空のときは行ごと出さない**(押しても開かない行が
/// 一番わるい)。ストア提出前に `dart_defines.env` を埋めること。
abstract final class SupportLinks {
  /// プライバシーポリシー。サブスクを載せる以上、審査で必ず見られる。
  static const String privacyPolicyUrl = String.fromEnvironment('PRIVACY_POLICY_URL');

  /// 利用規約(EULA)。自前のものが無ければ Apple の標準EULAのURLでよい。
  static const String termsUrl = String.fromEnvironment('TERMS_URL');

  /// 不適切な質問の報告先。AI生成物を含むアプリの導線として要る。
  static const String supportEmail = String.fromEnvironment('SUPPORT_EMAIL');

  static bool get hasPrivacyPolicy => privacyPolicyUrl.isNotEmpty;
  static bool get hasTerms => termsUrl.isNotEmpty;
  static bool get hasSupportEmail => supportEmail.isNotEmpty;

  /// 報告メールの下書き。端末IDとバージョンを本文に入れておくと、
  /// 「どの質問のことか」をこちらで辿れる。
  static Uri reportMail({
    required String subject,
    required String deviceId,
    required String version,
  }) {
    return Uri(
      scheme: 'mailto',
      path: supportEmail,
      queryParameters: <String, String>{
        'subject': subject,
        'body': '\n\n---\ndevice: $deviceId\nversion: $version\n',
      },
    );
  }
}
