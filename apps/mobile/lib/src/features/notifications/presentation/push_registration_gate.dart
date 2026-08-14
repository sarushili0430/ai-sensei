import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';

import '../application/push_controller.dart';
import '../data/push_repository.dart';

/// Watches device registration with OneSignal and shows a confirmation dialog
/// once.
///
/// Required by OneSignal's integration guide. Debug builds only: prompting for
/// notification permission on first launch clashes with this app's design
/// (never nag; permission is asked from the karte toggle alone). The wording
/// stays the guide's English and is not meant for Japanese users.
///
/// Flip [_enabled] to `true` to show it in release too.
///
/// It wraps the whole app without adding a route (it returns [child] as is).
/// The observer handle lives in State — a local variable would be collected and
/// the callbacks would stop firing.
class PushRegistrationGate extends ConsumerStatefulWidget {
  const PushRegistrationGate({
    required this.navigatorKey,
    required this.child,
    super.key,
  });

  /// Navigator used to show the dialog. It belongs to no screen, so the key is
  /// passed in to reach it from outside `MaterialApp.router`.
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

    // The ID can settle before the observer is attached, so waiting only for
    // changes would miss it forever; read the current value once too. Navigator
    // exists only after the first frame, hence post-frame.
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

  /// Wording is taken verbatim from OneSignal's integration guide, left
  /// untranslated so it matches the dashboard's verification steps.
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
