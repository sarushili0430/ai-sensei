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
import '../features/parent_report/presentation/parent_report_screen.dart';
import '../features/session/presentation/celebration_screen.dart';
import '../features/session/presentation/session_screen.dart';
import '../features/settings/presentation/settings_screen.dart';
import '../features/plan/presentation/plan_screen.dart';
import 'main_navigation_shell.dart';
import 'routes.dart';

part 'app_router.g.dart';

/// 画面遷移(docs/wireframe_v1.html の「画面遷移」に対応)。
///
/// 遷移を「常設の場所」と「授業の線」に分けている。混ぜると行き止まりか、
/// 授業中の抜け道ができる。
///
/// **常設の場所** — ホーム / 計画 / 設定。
///   枝ごとの履歴を保つ [StatefulShellRoute.indexedStack] に載せる。カルテは
///   授業直後だけの画面なので、常設タブにはせずホーム枝の子に残す。
///   自習室は畳んだ(コアループの外にあり、常設で戻る場所を1つ余分にしていた)。
///
/// **ホーム枝の寄り道(`push`)** — 復習 / カルテ / ペイウォール / お礼 / 親レポート。
///   戻れることが前提の画面。`/` の子ルートにしてあるので、
///   通知タップで `go('/review')` されたときもホームが下に入り、戻るが効く。
///
/// **授業の線** — 撮影 → 会話 → 祝福。
///   3画面ともシェルの外なので、板書の途中でタブから抜けられない。撮影だけは
///   `push` で入り、撮るのをやめれば元のホームへ戻れる。会話以降は
///   `go` でスタックを置き換え、終わった会話へ引き返せないようにする。
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
      StatefulShellRoute.indexedStack(
        builder: (_, _, StatefulNavigationShell navigationShell) =>
            MainNavigationShell(navigationShell: navigationShell),
        branches: <StatefulShellBranch>[
          StatefulShellBranch(
            routes: <RouteBase>[
              GoRoute(
                path: AppRoute.home.path,
                builder: (_, _) => const HomeScreen(),
                routes: <RouteBase>[
                  GoRoute(
                    path: AppRoute.karte.segment,
                    builder: (_, _) => const KarteScreen(),
                    // 直近のカルテが無いのにこの画面に来ても、出せるものが無い。
                    // 「うまくいきませんでした」を理由なく見せるより、ホームへ戻す。
                    redirect: (_, _) => ref.read(latestKarteControllerProvider) == null
                        ? AppRoute.home.path
                        : null,
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
                    redirect: (_, _) =>
                        ref.read(isPremiumProvider) ? null : AppRoute.home.path,
                  ),
                  GoRoute(
                    path: AppRoute.parentReport.segment,
                    builder: (_, _) => const ParentReportScreen(),
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: <RouteBase>[
              GoRoute(
                path: AppRoute.plan.path,
                builder: (_, _) => const PlanScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: <RouteBase>[
              GoRoute(
                path: AppRoute.settings.path,
                builder: (_, _) => const SettingsScreen(),
              ),
            ],
          ),
        ],
      ),
      // 撮影は戻れるが、タブは見せない。push した元の枝は下に残るので、
      // 撮るのをやめても来た場所を失わない。
      GoRoute(path: AppRoute.capture.path, builder: (_, _) => const CaptureScreen()),
      // 会話中とその直後。戻る先もタブも持たせない。
      GoRoute(path: AppRoute.session.path, builder: (_, _) => const SessionScreen()),
      GoRoute(
        path: AppRoute.celebration.path,
        builder: (_, _) => const CelebrationScreen(),
      ),
    ],
  );
}
