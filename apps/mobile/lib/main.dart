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

/// Startup, brought up inside monitoring.
///
/// Without `SENTRY_DSN`, [Telemetry.runWithMonitoring] skips init and calls
/// `_startApp` directly, so local and CI behave the same. Init runs after
/// `WidgetsFlutterBinding.ensureInitialized()` because the SDK uses
/// platform channels.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Telemetry.runWithMonitoring(_startApp);
}

Future<void> _startApp() async {
  // Orientation locking is left to AndroidManifest / Info.plist.
  // SystemChrome applies to every platform at once and would lock iPad to
  // portrait even though it allows landscape.

  // Resolve the anonymous device ID at startup (no account required).
  final SharedPreferences preferences = await SharedPreferences.getInstance();
  final String deviceId = await loadOrCreateDeviceId(preferences);
  final bool onboarded = await hasSeenOnboarding(preferences);

  // Configure RevenueCat once at startup. Inside a provider's build() it
  // would reconfigure on every rebuild, and it needs the device ID resolved
  // above to use as appUserID.
  //
  // A billing init failure must not block startup: losing the network should
  // not stop someone practising their explanation.
  try {
    await const PurchasesRepository().configure(appUserId: deviceId);
  } on Object catch (error, stack) {
    debugPrint('RevenueCat の初期化に失敗しました(無料のまま起動します): $error\n$stack');
  }

  runApp(
    ProviderScope(
      // Inject the values resolved at startup (types come from ProviderScope).
      overrides: [
        deviceIdProvider.overrideWithValue(deviceId),
        preferencesProvider.overrideWithValue(preferences),
        onboardedProvider.overrideWithValue(onboarded),
        // Real audio output is injected only at the app root; widgets default
        // to silence, so tests and previews never hit the MethodChannel.
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

    // Notification wiring (SDK init + external id). No permission prompt here.
    ref.watch(pushSetupProvider);

    // Billing wiring: re-read the server's verdict once a purchase or restore
    // grants Premium. Without this, buying leaves you free until a restart.
    ref.watch(premiumSyncProvider);

    // Notification tap landing. On a cold start the click arrives before the
    // widget tree, so it is carried here before navigating. Watched rather
    // than read so taps stored before this build are picked up too.
    if (ref.watch(pendingDeepLinkProvider) != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final String? path = ref.read(pendingDeepLinkProvider.notifier).take();
        if (path != null) router.go(path);
      });
    }

    // Debug-only dialog confirming the device registered with OneSignal.
    // It adds no route, so wrapping does not affect navigation.
    return PushRegistrationGate(
      navigatorKey: router.routerDelegate.navigatorKey,
      child: MaterialApp.router(
        // Name shown in the Android task switcher; matches the launcher's
        // `android:label` and the store listing.
        title: 'カタルテ',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        routerConfig: router,
        supportedLocales: AppStrings.supportedLocales,
        // Flutter resolves to the first supported locale on no match
        // (Japanese), so steer all but explicit Japanese to English.
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
