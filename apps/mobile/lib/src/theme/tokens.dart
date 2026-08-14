import 'package:flutter/material.dart';

/// Design tokens. We borrow Duolingo's grammar, not its vocabulary:
/// streaks, chunky buttons and character reactions yes; XP, leagues,
/// correctness scores and green-owl trade dress no.
abstract final class AppColors {
  /// Primary, actions, senpai.
  static const Color blue = Color(0xFF0EA5E9);

  /// Said it (yellow highlighter).
  static const Color said = Color(0xFFFFD93B);

  /// A gap (pink highlighter) — not lost points, but a place to fill.
  static const Color hole = Color(0xFFFF7AA8);

  /// Streaks and celebration.
  static const Color streak = Color(0xFFFF9F1C);

  /// Body text. Never pure black.
  static const Color ink = Color(0xFF33323D);
  static const Color inkMuted = Color(0xFF7A7887);

  static const Color surface = Color(0xFFFFFFFF);
  static const Color background = Color(0xFFFBFAF7);
  static const Color border = Color(0xFFE6E3DC);

  /// Celebration background: a warm ground tinted with the streak color.
  ///
  /// Screen backgrounds must be opaque. Passing
  /// `streak.withValues(alpha: 0.08)` straight to `Scaffold` leaves it 92%
  /// transparent: fine mid-transition while the old route shows through, but
  /// once that route leaves the tree there is nothing behind it (the device
  /// background, i.e. black) and [ink] body text sinks into it. We want the
  /// tint, not the transparency, so blend to an opaque color first.
  static final Color celebration = Color.alphaBlend(
    streak.withValues(alpha: 0.08),
    background,
  );
}

abstract final class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
}

abstract final class AppRadius {
  static const double button = 16;
  static const double card = 20;
  static const double chip = 999;
}

/// How far chunky buttons sink when pressed. The core of the feel.
abstract final class AppElevation {
  static const double chunkyDepth = 4;
}

abstract final class AppDurations {
  static const Duration tap = Duration(milliseconds: 90);
  static const Duration reaction = Duration(milliseconds: 220);
  static const Duration celebrate = Duration(milliseconds: 600);

  /// Entrance, per element.
  static const Duration enter = Duration(milliseconds: 320);

  /// Stagger before the next element appears. Simultaneous entrances
  /// erase the reading order.
  static const Duration stagger = Duration(milliseconds: 70);

  /// Highlighter speed — the time the nib takes to travel.
  static const Duration draw = Duration(milliseconds: 420);

  /// Senpai's breathing; blinking is derived from the same cycle.
  static const Duration breath = Duration(milliseconds: 3400);

  /// Per-character typing speed for senpai's lines.
  static const Duration typeChar = Duration(milliseconds: 45);

  /// How long "hold to explain" must be held to count as explaining.
  ///
  /// This is interaction time, not decoration, so reduced motion must not
  /// shorten it.
  static const Duration hold = Duration(milliseconds: 1300);
}

/// Motion feel. Only lively screens (conversation, celebration,
/// onboarding) may use [pop]; karte and review are reflective, so the
/// overshoot stays out.
abstract final class AppCurves {
  static const Curve enter = Curves.easeOutCubic;
  static const Curve exit = Curves.easeInCubic;
  static const Curve pop = Curves.easeOutBack;
  static const Curve breathe = Curves.easeInOut;
}
