import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import '../application/push_controller.dart';
import '../data/push_repository.dart';

/// 「先輩からのおさらい」を切り替えたときの処理。
///
/// **アプリ側に状態を持たない。** OSの許可がそのまま状態で、スイッチが出すのは
/// [PushPermission.granted] そのもの。二重に持つと
/// 「アプリではオンなのに届かない」が生まれる。
///
/// なので、どちらの向きも中身は「頼む」しかない:
///
///   - off → on … 許可を求める。**iOSはダイアログを一度しか出せない**ので、
///                 断られたあとに押しても何も出ない。設定への行き方を伝える。
///   - on → off … アプリからOSの許可は外せない。設定アプリへ送る。
///
/// 置き場所は設定とカルテの2つ([PushToggle])。同じ操作なので、
/// 許可まわりの細かい振る舞いは片方にだけ書かない。
Future<void> setPushNotifications(
  BuildContext context,
  WidgetRef ref, {
  required bool on,
}) async {
  if (!on) {
    await openAppSettings();
    return;
  }

  final AppStrings strings = AppStrings.of(context);
  final bool granted = await ref.read(pushPermissionControllerProvider.notifier).request();
  if (granted || !context.mounted) return;

  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(strings.karteReviewDenied),
      action: SnackBarAction(
        label: strings.settingsNotificationsOpenSettings,
        onPressed: openAppSettings,
      ),
    ),
  );
}

/// 「先輩からのおさらい」の on/off。振る舞いは [setPushNotifications]。
///
/// 通知を扱えないビルド(App ID の無いビルド)では**動かせないまま出す**。
/// 消すと行の右端だけが空き、押しても何も起きない行に見える。
class PushToggle extends ConsumerWidget {
  const PushToggle({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final PushPermission permission = ref.watch(pushPermissionControllerProvider);

    return Switch(
      value: permission.granted,
      activeThumbColor: AppColors.blue,
      onChanged: permission.available
          ? (bool on) => setPushNotifications(context, ref, on: on)
          : null,
    );
  }
}
