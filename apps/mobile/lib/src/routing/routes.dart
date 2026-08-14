import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

/// Screen identifiers — an enum purely to keep paths from scattering.
///
/// - Flat here, but the router nests review and karte under the home branch
/// - Nesting keeps home stacked underneath even for `go('/review')` from a
///   notification, so back works
/// - The permanent tabs are home / plan / settings (ADR 0006)
enum AppRoute {
  onboarding('/onboarding'),
  home('/'),
  capture('/capture'),
  session('/session'),
  celebration('/celebration'),
  karte('/karte'),
  review('/review'),
  paywall('/paywall'),
  thanks('/thanks'),
  settings('/settings'),

  /// Parent report: a detour you can back out of, reviewed before sharing.
  parentReport('/parent-report'),

  /// Study plan: a permanent tab that keeps work-in-progress state.
  plan('/plan');

  const AppRoute(this.path);

  final String path;

  /// Relative path for use as a child route of `/`.
  String get segment => path == '/' ? path : path.substring(1);
}

/// How screens close: pop back if we arrived by push, otherwise fall back
/// to home. For screens reachable more than one way, such as landing on
/// review straight from a notification.
extension AppNavigation on BuildContext {
  void closeOrGoHome() {
    if (canPop()) {
      pop();
    } else {
      go(AppRoute.home.path);
    }
  }

  /// Replaces the paywall with the thank-you screen.
  ///
  /// Replace rather than push: after buying, the only thing to go back to
  /// would be the buy screen. Replacing means closing the thank-you returns
  /// to wherever the paywall was opened from.
  void replaceWithThanks({bool restored = false}) =>
      pushReplacement(thanksLocation(restored: restored));

  /// Pushes the thank-you on top, for callers that must keep the screen
  /// underneath — restoring from settings, for instance.
  void pushThanks({bool restored = false}) => push(thanksLocation(restored: restored));
}

/// Destination for the thank-you screen. Only "restored" travels in the
/// query; whether it is a free trial is the entitlement's to know, and
/// passing it would give the screen and the SDK separate truths.
String thanksLocation({bool restored = false}) =>
    restored ? '${AppRoute.thanks.path}?restored=1' : AppRoute.thanks.path;
