import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/api/device_id.dart';
import 'src/audio/prerendered_audio.dart';
import 'src/features/monetization/application/premium_sync.dart';
import 'src/features/monetization/data/purchases_repository.dart';
import 'src/features/notifications/application/push_controller.dart';
import 'src/features/notifications/presentation/push_registration_gate.dart';
import 'src/l10n/strings.dart';
import 'src/routing/app_router.dart';
import 'src/telemetry/telemetry.dart';
import 'src/theme/app_theme.dart';

/// 起動。**監視の内側で立ち上げる**(計画書 §10-7)。
///
/// `SENTRY_DSN` が無いビルドでは [Telemetry.runWithMonitoring] が
/// 初期化ごと飛ばして `_startApp` をそのまま呼ぶので、手元とCIの挙動は変わらない。
/// 初期化を挟むのが `WidgetsFlutterBinding.ensureInitialized()` より**後**なのは、
/// SDKがプラットフォームチャンネルを使うため。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Telemetry.runWithMonitoring(_startApp);
}

Future<void> _startApp() async {
  // 向きの制限はネイティブ側(AndroidManifest / Info.plist)に任せている。
  // SystemChrome はプラットフォーム共通で効いてしまい、横向きを許している
  // iPad まで縦に固定してしまうため、ここでは指定しない。

  // 匿名デバイスIDは起動時に確定させる(アカウント作成は要求しない)
  final SharedPreferences preferences = await SharedPreferences.getInstance();
  final String deviceId = await loadOrCreateDeviceId(preferences);
  final bool onboarded = await hasSeenOnboarding(preferences);

  // RevenueCat は起動時に一度だけ設定する。
  //
  // provider の build() の中でやると再構築のたびに configure が走るので、
  // アプリの寿命に紐づくものはここに置く。デバイスIDを appUserID にするため、
  // 上のIDが確定したあとでなければ呼べない。
  //
  // 課金の初期化に失敗してもアプリは起動させる。ネットワークが無いだけで
  // 説明の練習ができなくなるのは本末転倒なので。
  try {
    await const PurchasesRepository().configure(appUserId: deviceId);
  } on Object catch (error, stack) {
    debugPrint('RevenueCat の初期化に失敗しました(無料のまま起動します): $error\n$stack');
  }

  runApp(
    ProviderScope(
      // 起動時に確定する値を差し込む(型は ProviderScope から推論される)
      overrides: [
        deviceIdProvider.overrideWithValue(deviceId),
        preferencesProvider.overrideWithValue(preferences),
        onboardedProvider.overrideWithValue(onboarded),
        // 本物の音声出力はアプリの根でだけ差し込む。Widget 単体の既定は無音なので、
        // テストやプレビューが MethodChannel を起動して端末から音を出すことはない。
        prerenderedAudioPlayerProvider.overrideWith((Ref ref) {
          final JustAudioPrerenderedAudioPlayer player = JustAudioPrerenderedAudioPlayer();
          ref.onDispose(() => unawaited(player.dispose()));
          return player;
        }),
      ],
      child: const AiSenseiApp(),
    ),
  );
}

class AiSenseiApp extends ConsumerWidget {
  const AiSenseiApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final GoRouter router = ref.watch(appRouterProvider);

    // 通知の配線(SDK初期化とexternal idの登録)。許可はここでは求めない。
    ref.watch(pushSetupProvider);

    // 課金の配線。購入・復元でPremiumになったら、サーバ側の判定を読み直す。
    // ここを外すと**買った直後は再起動するまで無料のまま**になる。
    ref.watch(premiumSyncProvider);

    // 通知タップの着地。コールドスタートではウィジェットツリーより先に
    // クリックが届くので、ここまで運んでから遷移する。
    // watch にしているのは、この build より前に置かれていた場合も拾うため。
    if (ref.watch(pendingDeepLinkProvider) != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final String? path = ref.read(pendingDeepLinkProvider.notifier).take();
        if (path != null) router.go(path);
      });
    }

    // 端末がOneSignalに登録できたことの確認ダイアログ(デバッグビルドのみ)。
    // 画面は足さないので、包んでも画面遷移には影響しない。
    return PushRegistrationGate(
      navigatorKey: router.routerDelegate.navigatorKey,
      child: MaterialApp.router(
        // Androidのタスクスイッチャーに出る名前。ランチャーの `android:label` と
        // ストアの表示名(カタルテ)に合わせる。
        title: 'カタルテ',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        routerConfig: router,
        supportedLocales: AppStrings.supportedLocales,
        // 既定の解決は「一致しなければ先頭(=日本語)」。海外の端末に
        // 日本語が出ないよう、日本語を望んだ端末以外は英語に寄せる。
        localeListResolutionCallback: (List<Locale>? preferred, Iterable<Locale> _) =>
            AppStrings.resolve(preferred),
        localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
          AppStringsDelegate(),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
      ),
    );
  }
}
