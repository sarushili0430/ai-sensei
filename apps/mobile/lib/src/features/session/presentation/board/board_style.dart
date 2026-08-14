import 'package:flutter/material.dart';

/// Extra values used only by the board layer.
///
/// `AppColors` is never changed or extended: the app's ground and body colors
/// stay as they are, and only colors used on the board live here. Durations
/// reuse the existing token (`AppDurations.draw`).
///
/// ## The board is a blackboard
///
/// The board used to be text sitting straight on the ground
/// (`AppColors.background`), with no edge saying where it began or ended.
/// Problem, formula and figure lay flat on the same paper, so nothing showed the
/// board was the lead.
///
/// Two materials instead: the problem is paper (a white card), the board is a
/// surface. The roles read without labels because the materials differ.
///
/// The colors match what the figure renderer (`render.js` in
/// `@ai-sensei/figure`) already uses: figure SVGs are drawn with background
/// `#2f3a35` and strokes `#edeae0`, so matching them makes the figure dissolve
/// into one continuous blackboard rather than float like a stamp. Green vs navy
/// was left "to decide on device" in wireframe v2, so change this only together
/// with the figure side (`render.js` / `docs/figeval/render.mjs`).
abstract final class BoardStyle {
  /// The board's ground; the same value as the figure SVG background.
  static const Color surface = Color(0xFF2F3A35);

  /// Text on the board (chalk); the same value as the figure SVG strokes.
  static const Color chalk = Color(0xFFEDEAE0);

  /// Muted text on the board (translations, notes, ticks): chalk dimmed.
  static const Color chalkMuted = Color(0xFF9FA8A2);

  /// "Look here" on the board; the same yellow as `as: "key"` in figure SVGs.
  ///
  /// Blue and pink sink into the board. Blackboard practice emphasises with
  /// underlines and boxes rather than color, but where lines are not enough
  /// (plot curves, angle marks) this chalk yellow is used.
  static const Color chalkKey = Color(0xFFF2D675);

  /// Base font size for LaTeX.
  ///
  /// Not a newly chosen number: it is the value used throughout the board's
  /// effective-width spike. The overflow measurements at 340pt and the FittedBox
  /// scale limits (54% / 32% / 24%) are all relative to this size, so changing it
  /// here alone would decouple those measurements from the implementation.
  static const double latexFontSize = 24;

  /// Lower bound on FittedBox scaling.
  ///
  /// Measured with deliberately long formulas (intrinsic width 624pt): 54% in a
  /// 340pt box was "just readable", 32% in a 200pt box was "hard". A 70% floor
  /// keeps every formula that measurably overflowed (76-97%) inside the range.
  ///
  /// Anything below that is a formula the agent should have split across two
  /// steps and did not — close to a contract violation. [LatexElementView] stops
  /// shrinking, pins 70% and falls back to horizontal scrolling as a safety valve
  /// (see that file).
  static const double latexMinScale = 0.70;

  /// Height of the `CustomPaint` drawing graphic primitives (plot / triangle /
  /// circle), sized to sit on one line as a single board step.
  static const double graphicHeight = 180;

  /// Font size for English example sentences.
  ///
  /// Smaller than formulas (24) because a sentence is that much longer: 120
  /// characters at 24pt runs to four or more lines at an effective width of
  /// 340pt, and one board step fills the screen. Slightly larger than body text,
  /// enough to separate it from notes.
  static const double sentenceFontSize = 18;

  /// Thickness of the `focus` underline. It points at part of a word, so it is
  /// thicker than a rule and thinner than a box.
  static const double focusUnderlineThickness = 2;

  /// The effective board width (pt) the measurements assumed: iPhone 15's 393pt
  /// minus padding.
  ///
  /// [latexMinScale] was chosen against this width, so a narrower actual width
  /// pushes formulas verified to fit into horizontal scrolling. That is invisible
  /// by eye, so falling below it is recorded (`Degradation.boardTooNarrow`).
  static const double measuredWidthAssumption = 340;

  /// Total horizontal board padding; every screen uses `AppSpacing.lg` x 2.
  static const double horizontalPadding = 48;

  /// The width the board should have on this device.
  ///
  /// Using [measuredWidthAssumption] as the threshold would trip on narrow
  /// devices by default: 340pt assumes iPhone 15 (393pt), while an iPhone SE
  /// (375pt) yields only 375 - 48 = 327pt. Reporting "the device is narrow" as a
  /// degradation would flood the data with every SE user and bury what we
  /// actually want to see — our own layout eating the width (a board wrapped in a
  /// card outside a lesson, down to 311pt).
  ///
  /// So the comparison is against the width this device should afford, and only
  /// layout eating into it falls below.
  static double expectedWidth(double screenWidth) {
    final double available = screenWidth - horizontalPadding;
    return available < measuredWidthAssumption ? available : measuredWidthAssumption;
  }
}
