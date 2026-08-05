import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/api/device_id.dart';
import 'src/features/monetization/data/purchases_repository.dart';
import 'src/features/notifications/application/push_controller.dart';
import 'src/l10n/strings.dart';
import 'src/routing/app_router.dart';
import 'src/theme/app_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

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

    // 通知タップの着地。コールドスタートではウィジェットツリーより先に
    // クリックが届くので、ここまで運んでから遷移する。
    // watch にしているのは、この build より前に置かれていた場合も拾うため。
    if (ref.watch(pendingDeepLinkProvider) != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final String? path = ref.read(pendingDeepLinkProvider.notifier).take();
        if (path != null) router.go(path);
      });
    }

    return MaterialApp.router(
      title: 'ai-sensei',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      routerConfig: router,
      supportedLocales: AppStrings.supportedLocales,
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        AppStringsDelegate(),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }
}
