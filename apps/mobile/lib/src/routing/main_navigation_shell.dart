import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../l10n/strings.dart';
import '../theme/tokens.dart';

/// 常設の4か所を行き来する下部ナビゲーション。
///
/// ピボット前は、常設で戻る先がホームしかなかったためタブを置かなかった。
/// カルテのような一過性の画面までタブにすると、授業前には中身のない場所が
/// 常に見えてしまうからでもある。その判断のうち、**カルテをタブにしない**部分は
/// いまも変わらない。
///
/// 一方、ピボット(計画書§0・§4)でホーム / 自習室 / 計画が、それぞれ途中の状態を
/// 保ったまま戻る常設の場所になった。設定も右上の小さな入口へ押し込めず、同じ
/// 大域ナビゲーションへ移す。4枝を [StatefulNavigationShell] に預けることで、
/// たとえば計画を見てから自習室へ戻っても、自習室の枝そのものは破棄しない。
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
            BottomNavigationBarItem(
              icon: const Icon(
                Icons.home_outlined,
                key: ValueKey<String>('navigation-home'),
              ),
              activeIcon: const Icon(
                Icons.home,
                key: ValueKey<String>('navigation-home'),
              ),
              label: strings.navigationHome,
            ),
            BottomNavigationBarItem(
              icon: const Icon(
                Icons.menu_book_outlined,
                key: ValueKey<String>('navigation-study-room'),
              ),
              activeIcon: const Icon(
                Icons.menu_book,
                key: ValueKey<String>('navigation-study-room'),
              ),
              label: strings.navigationStudyRoom,
            ),
            BottomNavigationBarItem(
              icon: const Icon(
                Icons.calendar_today_outlined,
                key: ValueKey<String>('navigation-plan'),
              ),
              activeIcon: const Icon(
                Icons.calendar_today,
                key: ValueKey<String>('navigation-plan'),
              ),
              label: strings.navigationPlan,
            ),
            BottomNavigationBarItem(
              icon: const Icon(
                Icons.settings_outlined,
                key: ValueKey<String>('navigation-settings'),
              ),
              activeIcon: const Icon(
                Icons.settings,
                key: ValueKey<String>('navigation-settings'),
              ),
              label: strings.navigationSettings,
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
