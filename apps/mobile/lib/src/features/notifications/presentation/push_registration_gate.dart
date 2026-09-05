import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';

import '../application/push_controller.dart';
import '../data/push_repository.dart';

/// OneSignal への端末登録を見張って、確認ダイアログを一度だけ出す。
///
/// OneSignal の統合手順が要求している「登録できたことを確かめる」ダイアログ。
/// **デバッグビルドでのみ出す。** 本番で出さないのは、初回起動でいきなり
/// 通知の許可を求めるのが、このアプリの設計(§6「煽らない」/ 許可を聞くのは
/// カルテのトグル1箇所だけ)と噛み合わないため。文面も手順書指定の英語のままで、
/// 日本語のユーザーに見せるものではない。
///
/// 本番でも出したくなったら [_enabled] を `true` に変える。
///
/// アプリ全体を包むだけで画面は足さない([child] をそのまま返す)。
/// 監視ハンドルは **State に持たせる** —— ローカル変数に入れただけだと
/// 参照が消えて通知が来なくなる。
class PushRegistrationGate extends ConsumerStatefulWidget {
  const PushRegistrationGate({
    required this.navigatorKey,
    required this.child,
    super.key,
  });

  /// ダイアログを出すための Navigator。どの画面にも属さないダイアログなので、
  /// `MaterialApp.router` の外側からでも辿れるようにキーを受け取る。
  final GlobalKey<NavigatorState> navigatorKey;

  final Widget child;

  @override
  ConsumerState<PushRegistrationGate> createState() => _PushRegistrationGateState();
}

class _PushRegistrationGateState extends ConsumerState<PushRegistrationGate> {
  static const bool _enabled = kDebugMode;

  PushRepository? _repository;
  OnPushSubscriptionChangeObserver? _observer;
  bool _dialogShown = false;

  @override
  void initState() {
    super.initState();
    if (!_enabled || !PushConfig.isConfigured) return;

    final PushRepository repository = ref.read(pushRepositoryProvider);
    void observer(OSPushSubscriptionChangedState state) =>
        _maybeShowDialog(state.current.id);

    _repository = repository;
    _observer = observer;
    repository.addPushSubscriptionObserver(observer);

    // 監視を付けるより前にIDが確定していることがある。変化だけを待つと
    // その取りこぼしで永久に出ないので、いまの値も一度見る。
    // Navigator が建つのは最初のフレームの後なので post-frame で。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _maybeShowDialog(repository.pushSubscriptionId);
    });
  }

  @override
  void dispose() {
    final OnPushSubscriptionChangeObserver? observer = _observer;
    if (observer != null) {
      _repository?.removePushSubscriptionObserver(observer);
    }
    super.dispose();
  }

  void _maybeShowDialog(String? subscriptionId) {
    if (_dialogShown || !mounted) return;
    if (!PushRepository.isRegistered(subscriptionId)) return;

    final BuildContext? navigatorContext = widget.navigatorKey.currentContext;
    if (navigatorContext == null) return;

    _dialogShown = true;
    _showIntegrationCompleteDialog(navigatorContext);
  }

  /// 文面は OneSignal の統合手順で指定されているものをそのまま使う
  /// (ダッシュボード側の確認手順と突き合わせるため、翻訳しない)。
  void _showIntegrationCompleteDialog(BuildContext context) {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('Your OneSignal SDK integration is complete!'),
        content: const Text(
          'You can now send Push Notifications & In-App Messages through '
          'OneSignal. Tap below to enable push notifications.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () {
              Navigator.pop(dialogContext);
              _repository?.requestPermission();
            },
            child: const Text('Got it'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
