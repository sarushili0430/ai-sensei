import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../l10n/strings.dart';
import '../theme/tokens.dart';

/// Bottom navigation across the three permanent places.
///
/// - Home / plan / settings, each returning to its in-progress state
/// - Branches live in [StatefulNavigationShell], so they survive round trips
/// - Karte is not a tab: before a lesson it would always sit empty
/// - The study room was dropped (ADR 0006)
/// - No glass or transparency; paper ground, white surfaces and rules only
class MainNavigationShell extends StatelessWidget {
  const MainNavigationShell({required this.navigationShell, super.key});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final TextStyle? labelStyle = Theme.of(context).textTheme.bodySmall;

    // Same order as `branches` in `app_router.dart`, kept as one table so
    // adding a destination cannot desync the two lists.
    final List<_NavigationDestination> destinations = <_NavigationDestination>[
      _NavigationDestination(
        id: 'home',
        icon: Icons.home_outlined,
        activeIcon: Icons.home,
        label: strings.navigationHome,
      ),
      _NavigationDestination(
        id: 'plan',
        icon: Icons.calendar_today_outlined,
        activeIcon: Icons.calendar_today,
        label: strings.navigationPlan,
      ),
      _NavigationDestination(
        id: 'settings',
        icon: Icons.settings_outlined,
        activeIcon: Icons.settings,
        label: strings.navigationSettings,
      ),
    ];

    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(
          color: AppColors.surface,
          border: Border(top: BorderSide(color: AppColors.border)),
        ),
        child: BottomNavigationBar(
          key: const ValueKey<String>('main-bottom-navigation'),
          currentIndex: navigationShell.currentIndex,
          type: BottomNavigationBarType.fixed,
          backgroundColor: AppColors.surface,
          elevation: 0,
          selectedItemColor: AppColors.blue,
          unselectedItemColor: AppColors.inkMuted,
          selectedLabelStyle: labelStyle?.copyWith(fontWeight: FontWeight.w700),
          unselectedLabelStyle: labelStyle,
          items: <BottomNavigationBarItem>[
            for (final _NavigationDestination destination in destinations)
              BottomNavigationBarItem(
                icon: Icon(destination.icon, key: ValueKey<String>('navigation-${destination.id}')),
                activeIcon: Icon(
                  destination.activeIcon,
                  key: ValueKey<String>('navigation-${destination.id}'),
                ),
                label: destination.label,
              ),
          ],
          onTap: (int index) {
            // Return to the history indexedStack holds instead of rebuilding
            // the branch with `go`. Re-tapping the current tab pops to its
            // root, since child screens like review need an explicit way out.
            navigationShell.goBranch(
              index,
              initialLocation: index == navigationShell.currentIndex,
            );
          },
        ),
      ),
    );
  }
}

/// One tab. Keeps icon and label together instead of in parallel arrays.
@immutable
class _NavigationDestination {
  const _NavigationDestination({
    required this.id,
    required this.icon,
    required this.activeIcon,
    required this.label,
  });

  /// Key widget tests tap. Independent of wording, so it is the same in
  /// both locales.
  final String id;
  final IconData icon;
  final IconData activeIcon;
  final String label;
}
