import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/api/device_id.dart';
import 'src/l10n/strings.dart';
import 'src/routing/app_router.dart';
import 'src/theme/app_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 匿名デバイスIDは起動時に確定させる(アカウント作成は要求しない)
  final SharedPreferences preferences = await SharedPreferences.getInstance();
  final String deviceId = await loadOrCreateDeviceId(preferences);

  runApp(
    ProviderScope(
      overrides: <Override>[deviceIdProvider.overrideWithValue(deviceId)],
      child: const AiSenseiApp(),
    ),
  );
}

class AiSenseiApp extends ConsumerWidget {
  const AiSenseiApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final GoRouter router = ref.watch(appRouterProvider);

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
