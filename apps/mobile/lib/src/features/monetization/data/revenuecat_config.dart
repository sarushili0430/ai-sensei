import 'package:flutter/foundation.dart';

/// RevenueCat configuration, all read from `--dart-define`.
///
/// Public SDK keys (`appl_` / `goog_` / `test_`) are meant to ship inside the
/// build artifact and need no secrecy. Secret keys (`sk_...`) and the webhook
/// shared secret must never appear here — those live in backend/api, and
/// `pnpm run verify:secrets` watches for leaks.
///
/// Values are collected in `apps/mobile/dart_defines.env` and passed with
/// `--dart-define-from-file=dart_defines.env`.
abstract final class RevenueCatConfig {
  /// Public SDK key for the App Store (`appl_...`).
  static const String iosKey = String.fromEnvironment('REVENUECAT_IOS_PUBLIC_SDK_KEY');

  /// Public SDK key for the Play Store (`goog_...`).
  static const String androidKey = String.fromEnvironment('REVENUECAT_ANDROID_PUBLIC_SDK_KEY');

  /// Test Store key (`test_...`).
  ///
  /// RevenueCat's simulated store, which runs the whole purchase flow before any
  /// products exist in App Store Connect / Play Console. The same value is used
  /// on iOS and Android; a platform-specific key takes precedence.
  static const String testStoreKey = String.fromEnvironment('REVENUECAT_SDK_KEY');

  /// Entitlement identifier from the dashboard.
  ///
  /// One wrong character means purchases succeed while nothing unlocks. Use the
  /// identifier, not the display name.
  static const String entitlementId = String.fromEnvironment(
    'REVENUECAT_ENTITLEMENT_ID',
    defaultValue: 'premium',
  );

  /// Set only to show a non-default Offering (for price experiments). Empty
  /// means the Offering marked current in RevenueCat.
  static const String offeringId = String.fromEnvironment('REVENUECAT_OFFERING_ID');

  static String apiKeyFor(TargetPlatform platform) {
    final String platformKey = switch (platform) {
      TargetPlatform.android => androidKey,
      _ => iosKey,
    };
    return platformKey.isNotEmpty ? platformKey : testStoreKey;
  }

  static String get apiKey => apiKeyFor(defaultTargetPlatform);

  /// Builds without keys (`flutter test`, CI, a forgotten flag) disable billing
  /// entirely and run as free; failing here would take unrelated screen tests
  /// down with it.
  static bool get isConfigured => apiKey.isNotEmpty;

  /// Whether we are on the Test Store; used to show that sales are not real.
  static bool get usesTestStore => apiKey.startsWith('test_');
}
