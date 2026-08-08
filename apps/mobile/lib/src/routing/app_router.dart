import 'package:go_router/go_router.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../api/device_id.dart';

import '../features/capture/presentation/capture_screen.dart';
import '../features/karte/application/karte_controllers.dart';
import '../features/karte/presentation/home_screen.dart';
import '../features/karte/presentation/karte_screen.dart';
import '../features/karte/presentation/review_screen.dart';
import '../features/monetization/application/entitlement_controller.dart';
import '../features/monetization/presentation/paywall_screen.dart';
import '../features/monetization/presentation/thanks_screen.dart';
import '../features/onboarding/presentation/onboarding_screen.dart';
import '../features/session/presentation/celebration_screen.dart';
import '../features/session/presentation/session_screen.dart';
import '../features/settings/presentation/settings_screen.dart';
import 'routes.dart';

part 'app_router.g.dart';

/// 画面遷移(docs/wireframe_v1.html の「画面遷移」に対応)。
///
/// 遷移を2種類に分けている。混ぜると行き止まりができる。
///
/// **一方通行(`go`)** — 撮影 → 会話 → 祝福 → カルテ。
///   会話に引き返せてはいけないので、スタックごと置き換える。
///   このためセッションと祝福だけは `/` の子にしない(ホームを下に積まない)。
///
/// **寄り道(`push`)** — ホーム ⇄ 復習 / 設定、カルテ・復習 ⇄ ペイウォール。
///   戻れることが前提の画面。`/` の子ルートにしてあるので、
///   通知タップで `go('/review')` されたときもホームが下に入り、戻るが効く。
@Riverpod(keepAlive: true)
GoRouter appRouter(Ref ref) {
  // 初回起動はオンボーディングから。約束(答えは教えない)を先に伝えたい。
  final bool onboarded = ref.watch(onboardedProvider);

  return GoRouter(
    initialLocation: onboarded ? AppRoute.home.path : AppRoute.onboarding.path,
    routes: <RouteBase>[
      GoRoute(
        path: AppRoute.onboarding.path,
        builder: (_, _) => const OnboardingScreen(),
      ),
      GoRoute(
        path: AppRoute.home.path,
        builder: (_, _) => const HomeScreen(),
        routes: <RouteBase>[
          GoRoute(
            path: AppRoute.capture.segment,
            builder: (_, _) => const CaptureScreen(),
          ),
          GoRoute(
            path: AppRoute.karte.segment,
            builder: (_, _) => const KarteScreen(),
            // 直近のカルテが無いのにこの画面に来ても、出せるものが無い。
            // 「うまくいきませんでした」を理由なく見せるより、ホームへ戻す。
            redirect: (_, _) =>
                ref.read(latestKarteControllerProvider) == null ? AppRoute.home.path : null,
          ),
          GoRoute(
            path: AppRoute.review.segment,
            builder: (_, _) => const ReviewScreen(),
          ),
          GoRoute(
            path: AppRoute.paywall.segment,
            builder: (_, _) => const PaywallScreen(),
          ),
          GoRoute(
            path: AppRoute.thanks.segment,
            builder: (_, GoRouterState state) =>
                ThanksScreen(restored: state.uri.queryParameters['restored'] == '1'),
            // 契約が無いのに祝わない。決済は通ったが entitlement が付いて
            // いない場合(ダッシュボードの設定漏れ)がここに来る。紙吹雪を
            // 見せてから使えないのが、いちばん落差が大きい。
            redirect: (_, _) => ref.read(isPremiumProvider) ? null : AppRoute.home.path,
          ),
          GoRoute(
            path: AppRoute.settings.segment,
            builder: (_, _) => const SettingsScreen(),
          ),
        ],
      ),
      // 会話中とその直後。戻る先を持たせない。
      GoRoute(path: AppRoute.session.path, builder: (_, _) => const SessionScreen()),
      GoRoute(
        path: AppRoute.celebration.path,
        builder: (_, _) => const CelebrationScreen(),
      ),
    ],
  );
}
