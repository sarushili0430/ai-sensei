import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/capture/presentation/capture_screen.dart';
import '../features/karte/presentation/home_screen.dart';
import '../features/karte/presentation/karte_screen.dart';
import '../features/karte/presentation/review_screen.dart';
import '../features/monetization/presentation/paywall_screen.dart';
import '../features/onboarding/presentation/onboarding_screen.dart';
import '../features/session/presentation/celebration_screen.dart';
import '../features/session/presentation/session_screen.dart';
import 'routes.dart';

/// 画面遷移(wireframe_v0.html の「画面遷移」に対応)。
///
///   00 → 01 → 02 → 03(会話) → 祝福 → カルテ
///   カルテ → ペイウォール(初回のみ) → ホーム
///   プッシュ通知 → 復習 → 会話
final Provider<GoRouter> appRouterProvider = Provider<GoRouter>((Ref ref) {
  return GoRouter(
    initialLocation: AppRoute.home.path,
    routes: <RouteBase>[
      GoRoute(
        path: AppRoute.onboarding.path,
        builder: (_, __) => const OnboardingScreen(),
      ),
      GoRoute(path: AppRoute.home.path, builder: (_, __) => const HomeScreen()),
      GoRoute(path: AppRoute.capture.path, builder: (_, __) => const CaptureScreen()),
      GoRoute(path: AppRoute.session.path, builder: (_, __) => const SessionScreen()),
      GoRoute(
        path: AppRoute.celebration.path,
        builder: (_, __) => const CelebrationScreen(),
      ),
      GoRoute(path: AppRoute.karte.path, builder: (_, __) => const KarteScreen()),
      GoRoute(path: AppRoute.review.path, builder: (_, __) => const ReviewScreen()),
      GoRoute(path: AppRoute.paywall.path, builder: (_, __) => const PaywallScreen()),
    ],
  );
});
