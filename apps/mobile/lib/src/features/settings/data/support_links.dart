/// Outbound links from settings, all read from `--dart-define`.
///
/// Values may be empty because, like keys, real ones should not live in the
/// repo. An empty value drops the whole row — a link that does not open is
/// the worst option. Fill `dart_defines.env` before store submission.
abstract final class SupportLinks {
  /// Privacy policy. Shipping a subscription means review will check it.
  static const String privacyPolicyUrl = String.fromEnvironment('PRIVACY_POLICY_URL');

  /// EULA. Apple's standard EULA URL is fine if we have none of our own.
  static const String termsUrl = String.fromEnvironment('TERMS_URL');

  /// Where to report bad questions; required for apps with AI-generated output.
  static const String supportEmail = String.fromEnvironment('SUPPORT_EMAIL');

  static bool get hasPrivacyPolicy => privacyPolicyUrl.isNotEmpty;
  static bool get hasTerms => termsUrl.isNotEmpty;
  static bool get hasSupportEmail => supportEmail.isNotEmpty;

  /// Draft report email. Embedding device ID and version lets us trace which
  /// question it refers to.
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
