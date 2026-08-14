import 'package:flutter/material.dart';

/// One place to decide whether to animate at all.
///
/// For anyone with iOS "Reduce Motion" or Android "Remove animations" on,
/// decorative motion is dropped entirely rather than shortened — the
/// setting exists for people it makes dizzy or nauseous.
///
/// When dropped, draw the finished state rather than freezing partway: an
/// entrance stopped at 0 leaves the body faint and looks broken.
///
/// Golden tests take this path too (`test/support/harness.dart` sets
/// `disableAnimations`), so a loop animation that skips it hangs
/// `pumpAndSettle` and the tests catch the omission.
abstract final class AppMotion {
  static bool isReduced(BuildContext context) =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  /// Duration for decorative animation; 0 (instantly finished) when
  /// motion is reduced. Never use it for interaction time such as
  /// hold-to-explain — zeroing what measures user input breaks it.
  static Duration decorative(BuildContext context, Duration value) =>
      isReduced(context) ? Duration.zero : value;

  /// Whether a screen reader is active.
  ///
  /// Timed gestures like press-and-hold always need a tap alternative: some
  /// people cannot hold, and a screen reader changes what a tap means.
  static bool prefersTapOverHold(BuildContext context) {
    final MediaQueryData? query = MediaQuery.maybeOf(context);
    return query?.accessibleNavigation ?? false;
  }
}
