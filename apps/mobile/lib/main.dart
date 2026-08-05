import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/api/device_id.dart';
import 'src/features/monetization/data/purchases_repository.dart';
import 'src/features/notifications/data/onesignal_repository.dart';
import 'src/features/notifications/presentation/push_registration_gate.dart';
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

  // OneSignal も起動時に一度だけ。RevenueCat と同じ理由でここに置く。
  //
  // external_id にデバイスIDを渡すのが要点。backend/api は
  // `include_aliases: { external_id: [deviceId] }` で復習プッシュを撃つので、
  // ここがずれると予約は通るのに端末には一通も届かない。
  //
  // 通知の初期化に失敗してもアプリは起動させる。プッシュが無いだけで
  // 説明の練習ができなくなるのは本末転倒なので。
  try {
    await const OneSignalRepository().configure(externalId: deviceId);
  } on Object catch (error, stack) {
    debugPrint('OneSignal の初期化に失敗しました(プッシュ無しで起動します): $error\n$stack');
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

    // 端末がOneSignalに登録できたら確認ダイアログを一度だけ出す。
    // 画面は足さないので、包んでも画面遷移には影響しない。
    return PushRegistrationGate(
      child: MaterialApp.router(
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
      ),
    );
  }
}
