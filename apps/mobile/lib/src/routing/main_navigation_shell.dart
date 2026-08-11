import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../l10n/strings.dart';
import '../theme/tokens.dart';

/// 常設の3か所を行き来する下部ナビゲーション。
///
/// ピボット前は、常設で戻る先がホームしかなかったためタブを置かなかった。
/// カルテのような一過性の画面までタブにすると、授業前には中身のない場所が
/// 常に見えてしまうからでもある。その判断のうち、**カルテをタブにしない**部分は
/// いまも変わらない。
///
/// 一方、ホームと計画は、それぞれ途中の状態を保ったまま戻る常設の場所になった。
/// 設定も右上の小さな入口へ押し込めず、同じ大域ナビゲーションへ移す。3枝を
/// [StatefulNavigationShell] に預けることで、たとえば設定を見てから計画へ戻っても、
/// 計画の枝そのものは破棄しない。
///
/// **自習室(旧4枝目)は畳んだ。** コアループ(撮る → 教わる → 教え返す →
/// カルテ → 復習)の外にあり、常設タブを1つ使いながら、そこから先へ進む道が
/// 「先輩を呼ぶ」= 結局ホームと同じ撮影しか無かったため。
///
/// ガラス表現や透過は使わない。アプリの地は紙で、既存の白い面と罫線だけで
/// 境界を作るほうが、板書・マーカーのデザイン言語を崩さないため。
class MainNavigationShell extends StatelessWidget {
  const MainNavigationShell({required this.navigationShell, super.key});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final TextStyle? labelStyle = Theme.of(context).textTheme.bodySmall;

    // 枝の並びは `app_router.dart` の `branches` と同じ順。行き先を足すときに
    // 2か所を別々に並べ替えてずれないよう、ここも1つの表として持つ。
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
            // 枝を `go` で作り直さず、indexedStack が持つ履歴へ戻る。
            // 選択中のタブをもう一度押したときだけ根へ戻すのは、復習などの
            // 子画面から「ホーム」を明示的に選ぶ操作には出口が必要だから。
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

/// タブ1つぶん。アイコンとラベルを別々の配列で持たないためだけの入れ物。
@immutable
class _NavigationDestination {
  const _NavigationDestination({
    required this.id,
    required this.icon,
    required this.activeIcon,
    required this.label,
  });

  /// widget test が押す先を指すキー。文言に依らないので日英で同じ。
  final String id;
  final IconData icon;
  final IconData activeIcon;
  final String label;
}
