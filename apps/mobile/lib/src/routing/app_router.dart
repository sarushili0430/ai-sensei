import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../api/device_id.dart';

import '../features/capture/presentation/capture_screen.dart';
import '../features/karte/presentation/home_screen.dart';
import '../features/karte/presentation/karte_screen.dart';
import '../features/karte/presentation/review_screen.dart';
import '../features/monetization/presentation/paywall_screen.dart';
import '../features/onboarding/presentation/onboarding_screen.dart';
import '../features/session/presentation/celebration_screen.dart';
import '../features/session/presentation/session_screen.dart';
import 'routes.dart';

part 'app_router.g.dart';

/// ルートの Navigator。
///
/// どの画面にも属さないダイアログ(プッシュ登録の確認など)を、
/// `MaterialApp.router` の外側からでも出せるようにするために公開している。
/// `MaterialApp.router` の `builder` は Router の**上**に入るので、
/// そこの context からは Navigator を辿れない。
@Riverpod(keepAlive: true)
GlobalKey<NavigatorState> rootNavigatorKey(Ref ref) =>
    GlobalKey<NavigatorState>(debugLabel: 'root');

/// 画面遷移(wireframe_v0.html の「画面遷移」に対応)。
///
///   00 → 01 → 02 → 03(会話) → 祝福 → カルテ
///   カルテ → ペイウォール(初回のみ) → ホーム
///   プッシュ通知 → 復習 → 会話
@Riverpod(keepAlive: true)
GoRouter appRouter(Ref ref) {
  // 初回起動はオンボーディングから。約束(答えは教えない)を先に伝えたい。
  final bool onboarded = ref.watch(onboardedProvider);

  return GoRouter(
    navigatorKey: ref.watch(rootNavigatorKeyProvider),
    initialLocation: onboarded ? AppRoute.home.path : AppRoute.onboarding.path,
    routes: <RouteBase>[
      GoRoute(
        path: AppRoute.onboarding.path,
        builder: (_, _) => const OnboardingScreen(),
      ),
      GoRoute(path: AppRoute.home.path, builder: (_, _) => const HomeScreen()),
      GoRoute(path: AppRoute.capture.path, builder: (_, _) => const CaptureScreen()),
      GoRoute(path: AppRoute.session.path, builder: (_, _) => const SessionScreen()),
      GoRoute(
        path: AppRoute.celebration.path,
        builder: (_, _) => const CelebrationScreen(),
      ),
      GoRoute(path: AppRoute.karte.path, builder: (_, _) => const KarteScreen()),
      GoRoute(path: AppRoute.review.path, builder: (_, _) => const ReviewScreen()),
      GoRoute(path: AppRoute.paywall.path, builder: (_, _) => const PaywallScreen()),
    ],
  );
}
