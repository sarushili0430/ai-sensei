import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/device_id.dart';
import '../../../routing/routes.dart';
import '../data/push_repository.dart';

part 'push_controller.g.dart';

@Riverpod(keepAlive: true)
PushRepository pushRepository(Ref ref) => const PushRepository();

/// 通知まわりの配線。`AiSenseiApp` が一度だけ watch して起動する。
///
/// やるのは SDK の初期化と、宛先になる external id(= 匿名デバイスID)の登録、
/// それに通知タップの受け口。**許可はここでは求めない**(文脈内で聞く)。
@Riverpod(keepAlive: true)
class PushSetup extends _$PushSetup {
  @override
  Future<void> build() async {
    final PushRepository repository = ref.read(pushRepositoryProvider);
    await repository.configure(deviceId: ref.read(deviceIdProvider));
    repository.onOpened((String? holeId) {
      // 穴の指定までは見ない。復習画面に同じ穴がカードで出ている。
      ref.read(pendingDeepLinkProvider.notifier).set(AppRoute.review.path);
    });
  }
}

/// 通知の許可状態。
///
/// 許可を求める場所はカルテ画面のトグル1箇所だけ。初回起動では聞かない。
/// 「穴が見つかった直後に、先輩がもう一度きいてもいいかを尋ねる」ほうが
/// 文脈が立っているし、約束4「煽らない」とも噛み合う。
///
/// **配役が先輩に変わって、ここは前より効くようになった。**
/// 後輩の「お願い」は断りにくさが無い代わりに軽い。先輩が
/// 「もう一度きいてもいい?」と**頼む**のは、言い切れる立場の人が
/// あえて頼んでいるぶん、許可を求めていることがはっきりする。
@Riverpod(keepAlive: true)
class PushPermissionController extends _$PushPermissionController {
  @override
  PushPermission build() {
    if (!PushConfig.isConfigured) return PushPermission.unavailable;
    return PushPermission(
      granted: ref.read(pushRepositoryProvider).hasPermission,
      available: true,
    );
  }

  /// 許可を求める。断られたら状態はそのまま(トグルは戻る)。
  Future<bool> request() async {
    final bool granted = await ref.read(pushRepositoryProvider).requestPermission();
    state = PushPermission(granted: granted, available: PushConfig.isConfigured);
    return granted;
  }
}

/// 通知タップの着地先。
///
/// クリックは**アプリの起動より先**に届きうる(コールドスタート)ので、
/// その場で画面遷移せずここに置いておき、ウィジェットツリーが立ってから運ぶ。
@Riverpod(keepAlive: true)
class PendingDeepLink extends _$PendingDeepLink {
  @override
  String? build() => null;

  void set(String path) => state = path;

  /// 一度運んだら消す。画面を戻るたびに引きずり込まれないように。
  String? take() {
    final String? path = state;
    state = null;
    return path;
  }
}
