import 'package:flutter/foundation.dart';

/// RevenueCat の設定値。すべて `--dart-define` から読む。
///
/// 公開SDKキー(`appl_` / `goog_` / `test_`)は**ビルド成果物に埋め込まれる
/// 前提の値**なので秘匿不要。逆に、シークレットキー(`sk_...`)や
/// webhook の共有シークレットは絶対にここへ置かない — それらは
/// backend/api 側にあり、`pnpm run verify:secrets` が混入を見張っている。
///
/// 値は `apps/mobile/dart_defines.env` にまとめて置き、
/// `--dart-define-from-file=dart_defines.env` で渡す。
abstract final class RevenueCatConfig {
  /// App Store 用の公開SDKキー(`appl_...`)。
  static const String iosKey = String.fromEnvironment('REVENUECAT_IOS_PUBLIC_SDK_KEY');

  /// Play Store 用の公開SDKキー(`goog_...`)。
  static const String androidKey = String.fromEnvironment('REVENUECAT_ANDROID_PUBLIC_SDK_KEY');

  /// Test Store の鍵(`test_...`)。
  ///
  /// App Store Connect / Play Console に商品を作る前でも購入フローを
  /// 最後まで通せる RevenueCat 側の疑似ストア。**iOS/Android で同じ値**を使う。
  /// プラットフォーム別の鍵が入っていればそちらが優先される。
  static const String testStoreKey = String.fromEnvironment('REVENUECAT_SDK_KEY');

  /// ダッシュボードの Entitlement identifier。
  ///
  /// **ここが1文字でもずれると、課金は成立するのに何も解放されない。**
  /// 表示名ではなく identifier のほうを入れること。
  static const String entitlementId = String.fromEnvironment(
    'REVENUECAT_ENTITLEMENT_ID',
    defaultValue: 'premium',
  );

  /// 既定以外の Offering を出したいときだけ指定する(価格の実験用)。
  /// 空なら RevenueCat 側で current に設定した Offering を使う。
  static const String offeringId = String.fromEnvironment('REVENUECAT_OFFERING_ID');

  static String apiKeyFor(TargetPlatform platform) {
    final String platformKey = switch (platform) {
      TargetPlatform.android => androidKey,
      _ => iosKey,
    };
    return platformKey.isNotEmpty ? platformKey : testStoreKey;
  }

  static String get apiKey => apiKeyFor(defaultTargetPlatform);

  /// 鍵の無いビルド(`flutter test` / CI / 鍵の渡し忘れ)では、
  /// 課金機能ごと黙って無効にして無料のまま動かす。
  /// ここで落とすと、課金と関係ない画面のテストまで巻き添えになる。
  static bool get isConfigured => apiKey.isNotEmpty;

  /// Test Store で動いているか。実売でないことを画面に出すために使う。
  static bool get usesTestStore => apiKey.startsWith('test_');
}
