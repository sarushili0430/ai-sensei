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

/// 画面遷移の正。「常設の場所」と「授業の線」を混ぜない。
/// 混ぜると行き止まりか、授業中の抜け道ができる。
///
/// - **常設** ホーム / 計画 / 設定。枝ごとの履歴を `indexedStack` で保つ
/// - カルテは授業直後だけの画面なのでタブにせず、ホーム枝の子に置く
/// - **寄り道(push)** 復習・カルテ・ペイウォール・お礼・親レポート
/// - 寄り道を `/` の子にすると、通知着地でもホームが下に入り戻れる
/// - **授業の線** 撮影 → 会話 → 祝福。シェルの外でタブから抜けられない
/// - 撮影だけ `push`。会話以降は `go` で置き換え、引き返せなくする
///
/// | 画面 | 入り方 | 出口 |
/// | --- | --- | --- |
/// | オンボーディング | 初回起動 | はじめる → ホーム(置き換え) |
/// | ホーム | タブ / 起点 | 撮影 / 復習 / 親レポート / ペイウォール |
/// | 撮影 | ホームから push | 戻る・授業をはじめる → 会話(置き換え) |
/// | 会話 | 撮影・復習から置き換え | 終わる → 祝福。**戻るは出さない** |
/// | 祝福 | 会話から置き換え | カルテへ(下にホームが積まれる) |
/// | カルテ | 祝福から | 言い直す → 復習 / 今日はここまで → ホーム or ペイウォール |
/// | 復習 | ホームから push / 通知から | 戻る・説明する → 会話 |
/// | ペイウォール | カルテ・復習・ホームから | 閉じる → **来た場所** / 購入 → お礼へ差し替え |
/// | 親レポート | ホームのカウンターから push | 戻る → ホーム |
/// | 計画・設定 | タブ | 同じタブでホームへ |
@Riverpod(keepAlive: true)
GoRouter appRouter(Ref ref) {
  // 初回起動はオンボーディングから。約束を先に伝えたい。
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
