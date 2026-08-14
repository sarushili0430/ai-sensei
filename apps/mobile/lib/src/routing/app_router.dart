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

/// Navigation. Permanent places and the lesson line never mix — mixing them
/// creates either a dead end or an escape hatch mid-lesson.
///
/// - Permanent: home / plan / settings, per-branch history via `indexedStack`
/// - Karte belongs to just after a lesson, so it is a child of the home
///   branch rather than a tab
/// - Detours (push): review, karte, paywall, thank-you, parent report
/// - Making detours children of `/` keeps home underneath on notification
///   landings, so back works
/// - Lesson line: capture -> conversation -> celebration, outside the shell
///   so tabs cannot be used to leave
/// - Only capture uses `push`; from the conversation on, `go` replaces so
///   there is no turning back
@Riverpod(keepAlive: true)
GoRouter appRouter(Ref ref) {
  // First launch starts at onboarding: state the promise first.
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
                    // Nothing to show without a recent karte. Send them home
                    // rather than an unexplained failure message.
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
                    // No entitlement, no celebration. Payment can succeed while
                    // entitlement is missing (dashboard misconfiguration), and
                    // confetti followed by a locked app is the worst drop.
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
      // Capture can be backed out of but shows no tabs; the branch it was
      // pushed from stays underneath, so cancelling keeps your place.
      GoRoute(path: AppRoute.capture.path, builder: (_, _) => const CaptureScreen()),
      // During the conversation and just after: no back target, no tabs.
      GoRoute(path: AppRoute.session.path, builder: (_, _) => const SessionScreen()),
      GoRoute(
        path: AppRoute.celebration.path,
        builder: (_, _) => const CelebrationScreen(),
      ),
    ],
  );
}
