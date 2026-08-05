import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';

import '../../../routing/app_router.dart';
import '../data/onesignal_config.dart';
import '../data/onesignal_repository.dart';

/// OneSignal への端末登録を見張って、確認ダイアログを一度だけ出す。
///
/// アプリ全体を包むだけで画面は足さない([child] をそのまま返す)。
/// 監視ハンドルは **State に持たせる** —— ローカル変数に入れただけだと
/// 参照が消えて通知が来なくなる。
///
/// ダイアログは特定の画面に属さないので、`MaterialApp.router` の外側からでも
/// 出せるように [rootNavigatorKeyProvider] の context を使う。
class PushRegistrationGate extends ConsumerStatefulWidget {
  const PushRegistrationGate({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<PushRegistrationGate> createState() => _PushRegistrationGateState();
}

class _PushRegistrationGateState extends ConsumerState<PushRegistrationGate> {
  OneSignalRepository? _repository;
  OnPushSubscriptionChangeObserver? _observer;
  bool _dialogShown = false;

  @override
  void initState() {
    super.initState();
    if (!OneSignalConfig.isConfigured) return;

    final OneSignalRepository repository = ref.read(oneSignalRepositoryProvider);
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
    if (!OneSignalRepository.isRegistered(subscriptionId)) return;

    final BuildContext? navigatorContext =
        ref.read(rootNavigatorKeyProvider).currentContext;
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
              // 通知の許可を求めるのはここだけ。起動直後に出すと、
              // 何のアプリか分からないまま拒否されて二度と出せない。
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
