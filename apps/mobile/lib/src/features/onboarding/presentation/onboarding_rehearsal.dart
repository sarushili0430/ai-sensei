import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../session/domain/board.dart';
import '../../session/presentation/board/board_view.dart';

/// Marker for the band ([_BottomFade]) showing the board continues below.
///
/// Whether it appears is itself the spec — no cue while content is cut off is
/// the worst state, and showing it when nothing is cut is a lie — so this key
/// makes it testable without relying on appearance.
const Key onboardingBoardMoreBelowKey = Key('onboarding_board_more_below');

/// Outcome of the rehearsal.
enum RehearsalOutcome {
  /// Taught it back — yellow marker.
  explained,

  /// Could not say it — pink marker (a gap). Not a failure.
  passed,
}

/// Onboarding page 3 — the rehearsal.
///
/// Replaces an explanation that only feels understood with actually doing it
/// once. Anyone who passes through has experienced both "senpai teaches on the
/// board" and "what I couldn't explain stays" before ever pressing the shutter.
///
/// The claim of this page: having the answer in front of you does not mean you
/// can explain it. The board states the conclusion (`two roots ⇔ D > 0`) and
/// hides nothing, yet "why do we look at D again?" still stalls — that stall is
/// the gap, and the whole reason teaching is not the end. What used to show only
/// the question (to avoid giving the answer) now shows the answer and then asks.
///
/// Three rules:
///   - Nothing is connected. Board and question are a fixed script; no LiveKit,
///     no API.
///   - No permissions. Neither mic nor camera; the screen says nothing is
///     recorded.
///   - No right answer. Teaching back and passing both advance, and neither is
///     held against you.
///
/// ## The screen is split into a reading half and a doing half
///
/// Stacking the board made it taller, and at 375x667 the controls fell below the
/// fold. Missing controls matter more than a partly hidden board: a cut-off
/// board still works as long as "more below" is clear, but invisible controls
/// mean the page gets swiped past without anyone realising there is something to
/// do — and this page exists to be done, not read.
///
/// Hence the split:
///   - top (scrolls): heading, the photographed problem, the board
///   - bottom (fixed): senpai's face and bubble, the controls, the "not
///     recorded" note
///
/// The face and bubble are fixed because the face is the feedback while holding:
/// the expression changes to `listening`, so scrolling it away would remove the
/// only sign of being heard. The bubble's question is the meaning of the control
/// itself, so it stays too.
class OnboardingRehearsalPage extends StatefulWidget {
  const OnboardingRehearsalPage({required this.outcome, required this.onOutcome, super.key});

  final RehearsalOutcome? outcome;

  /// Reports the outcome to the parent once decided, or cleared by "try again".
  /// Page 4's sample karte uses it directly.
  final ValueChanged<RehearsalOutcome?> onOutcome;

  @override
  State<OnboardingRehearsalPage> createState() => _OnboardingRehearsalPageState();
}

class _OnboardingRehearsalPageState extends State<OnboardingRehearsalPage> {
  /// Controls stay hidden until the question finishes typing — nothing has been
  /// asked yet.
  bool _asked = false;
  bool _holding = false;

  /// The face never clouds over when they could not explain.
  ///
  /// The junior version used [SenpaiMood.puzzled] here: for a junior it merely
  /// stated "I listened and didn't understand", carrying no blame. From senpai
  /// it reads as disappointment that the teaching did not land. Getting stuck is
  /// expected — it is what we came to find — so the face stays as it received it
  /// and only words and markers respond.
  SenpaiMood get _mood => switch (widget.outcome) {
    RehearsalOutcome.explained => SenpaiMood.delighted,
    RehearsalOutcome.passed => SenpaiMood.neutral,
    null => _holding ? SenpaiMood.listening : SenpaiMood.neutral,
  };

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // The reading half; only this scrolls.
        Flexible(
          child: _ScrollWithBottomFade(
            child: CenteredScroll(
              children: <Widget>[
                const SizedBox(height: AppSpacing.md),
                FadeSlideIn(
                  child: Text(
                    strings.onboardingTryTitle,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                const FadeSlideIn.staggered(index: 1, child: _NotebookCard()),
                // Problem and board are one unit, so tighten the gap between.
                const SizedBox(height: AppSpacing.md),
                const FadeSlideIn.staggered(index: 2, child: _SenpaiBoard()),
                const SizedBox(height: AppSpacing.md),
              ],
            ),
          ),
        ),
        // The doing half; never allowed below the fold.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              FadeSlideIn.staggered(
                index: 3,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: <Widget>[
                    SenpaiFace(mood: _mood, size: 76),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: _SpeechBubble(
                        child: TypingText(
                          strings.onboardingTryQuestion,
                          style: Theme.of(context).textTheme.bodyLarge,
                          onDone: () {
                            if (mounted && !_asked) setState(() => _asked = true);
                          },
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              _resize(
                child: _asked ? _buildAnswer(strings) : const SizedBox(width: double.infinity),
              ),
              // The note sits between the control and "next": two same-width
              // buttons in a row blur which one is the current move.
              const SizedBox(height: AppSpacing.sm),
              Text(
                strings.onboardingTryNotRecording,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
          ),
        ),
      ],
    );
  }

  /// Height changes across question -> control -> outcome; this smooths the
  /// jumps.
  ///
  /// [AnimatedSize] rejects a zero duration (it re-lays-out itself mid-layout and
  /// crashes), so under reduced motion the child is returned unwrapped.
  Widget _resize({required Widget child}) {
    if (AppMotion.isReduced(context)) return child;

    return AnimatedSize(
      duration: AppDurations.reaction,
      curve: AppCurves.enter,
      alignment: Alignment.topCenter,
      child: child,
    );
  }

  Widget _buildAnswer(AppStrings strings) {
    final RehearsalOutcome? outcome = widget.outcome;
    if (outcome == null) {
      return Column(
        key: const ValueKey<String>('ask'),
        children: <Widget>[
          _HoldToExplainButton(
            onHoldChanged: (bool value) => setState(() => _holding = value),
            onExplained: () => widget.onOutcome(RehearsalOutcome.explained),
          ),
          // Passing is not shameful: not the same weight, but never hidden.
          GhostButton(
            label: strings.sessionPass,
            onPressed: () => widget.onOutcome(RehearsalOutcome.passed),
          ),
        ],
      );
    }

    final bool explained = outcome == RehearsalOutcome.explained;
    return Column(
      key: ValueKey<RehearsalOutcome>(outcome),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          explained ? strings.onboardingTrySaidReaction : strings.onboardingTryHoleReaction,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.md),
        _KarteLine(
          title: explained ? strings.karteSaidWell : strings.karteHoles(1),
          text: explained ? strings.onboardingTrySaid : strings.onboardingTryHole,
          marker: explained ? MarkerColor.said : MarkerColor.hole,
        ),
        GhostButton(
          label: strings.onboardingTryAgain,
          onPressed: () {
            setState(() => _holding = false);
            widget.onOutcome(null);
          },
        ),
      ],
    );
  }
}

/// Stands in for the photographed problem; no real photo, since the camera is
/// not opened yet.
///
/// Slightly tilted so it reads as paper on a desk — set straight, it looks like
/// a workbook the app supplied.
class _NotebookCard extends StatelessWidget {
  const _NotebookCard();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Transform.rotate(
      angle: -0.012,
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.card),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(strings.onboardingTryNotebookLabel, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.xs),
            Text(strings.onboardingTryNotebook, style: Theme.of(context).textTheme.titleMedium),
          ],
        ),
      ),
    );
  }
}

/// A scroll area with a band signalling more content below.
///
/// The vertical counterpart of `LatexElementView`'s right-edge fade
/// (`_ScrollWithEdgeFade`), on the same criterion: it guarantees not that
/// scrolling is possible but that it is visibly possible. The reason horizontal
/// scrolling was rejected for the board — a still frame gives no cue that more
/// follows, so it reads as "that's all" — applies just as much vertically. The
/// band disappears once the end is visible, since keeping a cue up when nothing
/// is hidden would be a lie.
///
/// The inner [CenteredScroll] is a shared widget that does not expose its
/// `ScrollController`, so position comes from notifications:
/// `ScrollMetricsNotification` covers the first layout and `ScrollNotification`
/// covers dragging.
///
/// The default is "nothing below", the opposite of `_ScrollWithEdgeFade` (which
/// assumes "maybe" before measuring). Vertically, screens where it fits are the
/// common case (Japanese fits at 393x852), so defaulting to visible would flash
/// a shadow over a screen with nothing cut off. Notifications arrive on the
/// first layout, so being late costs nothing.
class _ScrollWithBottomFade extends StatefulWidget {
  const _ScrollWithBottomFade({required this.child});

  final Widget child;

  @override
  State<_ScrollWithBottomFade> createState() => _ScrollWithBottomFadeState();
}

class _ScrollWithBottomFadeState extends State<_ScrollWithBottomFade> {
  bool _hasMore = false;

  void _update(ScrollMetrics metrics) {
    final bool hasMore = metrics.extentAfter > 1;
    if (hasMore == _hasMore) return;

    // Notifications arrive right after layout; calling setState there would
    // rebuild mid-frame, so defer to the next frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && hasMore != _hasMore) setState(() => _hasMore = hasMore);
    });
  }

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (ScrollMetricsNotification notification) {
        _update(notification.metrics);
        return false;
      },
      child: NotificationListener<ScrollNotification>(
        onNotification: (ScrollNotification notification) {
          _update(notification.metrics);
          return false;
        },
        child: Stack(
          children: <Widget>[
            widget.child,
            if (_hasMore)
              const Positioned(
                key: onboardingBoardMoreBelowKey,
                left: 0,
                right: 0,
                bottom: 0,
                child: IgnorePointer(child: _BottomFade()),
              ),
          ],
        ),
      ),
    );
  }
}

/// The band itself. Colors stay within existing tokens
/// (`AppColors.background`, transparent to opaque); no new color is defined.
class _BottomFade extends StatelessWidget {
  const _BottomFade();

  static const double _height = 28;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: _height,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            // alpha:0 is that color made transparent, not a different color.
            colors: <Color>[
              AppColors.background.withValues(alpha: 0),
              AppColors.background,
            ],
          ),
        ),
      ),
    );
  }
}

/// The board senpai wrote: the production [BoardView] fed a fixed script.
///
/// It gets no separate look, because a rehearsal board that differed from the
/// lesson board would stop this page working as a preview. Neither LiveKit nor
/// `BoardChannelReceiver` is involved — the steps are already here, so there is
/// nothing to route.
///
/// Not placed on a white card. `LatexElementView`'s right-edge fade is drawn
/// assuming the board sits directly on the screen background
/// (`AppColors.background`), documented as a known premise beside `_EdgeFade` in
/// that file. On another ground the fade alone would mismatch once a long
/// formula arrives. So it sits on the background, separated only by a heading.
class _SenpaiBoard extends StatelessWidget {
  const _SenpaiBoard();

  /// Step two. Formulas carry no locale, so it lives here directly (step one's
  /// prose is a `text` element in `strings`; Japanese inside LaTeX renders as
  /// mojibake).
  ///
  /// A short formula is a deliberate choice: it fits without falling back to
  /// horizontal scrolling at `BoardStyle.latexMinScale` (70%).
  static const String _tex = r'D = (-4)^2 - 4k > 0';

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(strings.onboardingTryBoardLabel, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: AppSpacing.xs),
        BoardView(
          // The empty `speech` is deliberate: this page makes no sound, and "no
          // speaking while writing" is the board layer's principle anyway, so a
          // board-only step is also correct in production.
          steps: <BoardStep>[
            BoardStep(
              index: 0,
              speech: '',
              board: BoardElement.text(body: strings.onboardingTryBoardText),
            ),
            const BoardStep(index: 1, speech: '', board: BoardElement.latex(tex: _tex)),
          ],
        ),
      ],
    );
  }
}

/// Senpai's speech bubble; the tail points left so the face is clearly speaking.
class _SpeechBubble extends StatelessWidget {
  const _SpeechBubble({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        const CustomPaint(size: Size(8, 14), painter: _TailPainter()),
        Expanded(
          child: Container(
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: AppColors.blue.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(AppRadius.card),
            ),
            child: child,
          ),
        ),
      ],
    );
  }
}

class _TailPainter extends CustomPainter {
  const _TailPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = Path()
      ..moveTo(size.width, 0)
      ..lineTo(0, size.height / 2)
      ..lineTo(size.width, size.height)
      ..close();
    canvas.drawPath(path, Paint()..color = AppColors.blue.withValues(alpha: 0.08));
  }

  @override
  bool shouldRepaint(_TailPainter oldDelegate) => false;
}

/// A karte with a single line, using the real karte's heading and markers.
class _KarteLine extends StatelessWidget {
  const _KarteLine({required this.title, required this.text, required this.marker});

  final String title;
  final String text;
  final MarkerColor marker;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          // A short wait before drawing, leaving time to read the reply.
          MarkerText(text, marker: marker, delay: AppDurations.reaction),
        ],
      ),
    );
  }
}

/// Senpai listens only while the button is held.
///
/// Real sessions involve speaking continuously, so this is a press-and-hold too.
/// The hold time is a metaphor for explaining, so reduced motion does not
/// shorten it ([AppDurations.hold]). For anyone who cannot hold, a tap suffices
/// when a screen reader is active.
class _HoldToExplainButton extends StatefulWidget {
  const _HoldToExplainButton({required this.onHoldChanged, required this.onExplained});

  final ValueChanged<bool> onHoldChanged;
  final VoidCallback onExplained;

  @override
  State<_HoldToExplainButton> createState() => _HoldToExplainButtonState();
}

class _HoldToExplainButtonState extends State<_HoldToExplainButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _progress = AnimationController(
    vsync: this,
    duration: AppDurations.hold,
  );
  bool _holding = false;
  bool _showHint = false;

  @override
  void initState() {
    super.initState();
    _progress.addStatusListener((AnimationStatus status) {
      if (status != AnimationStatus.completed) return;
      HapticFeedback.mediumImpact();
      widget.onExplained();
    });
  }

  @override
  void dispose() {
    _progress.dispose();
    super.dispose();
  }

  void _setHolding(bool value) {
    if (_holding == value) return;
    setState(() => _holding = value);
    widget.onHoldChanged(value);
  }

  void _start() {
    HapticFeedback.selectionClick();
    _setHolding(true);
    setState(() => _showHint = false);
    _progress.forward();
  }

  void _stop() {
    if (_progress.isCompleted) return;
    _setHolding(false);
    // Released early. No blame; just explain how to hold.
    if (_progress.value > 0.05) setState(() => _showHint = true);
    _progress.reverse();
  }

  /// Released without holding. With a screen reader, this is the proper action.
  void _tapped() {
    if (!AppMotion.prefersTapOverHold(context)) return;
    _progress.value = 1;
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final bool tapInstead = AppMotion.prefersTapOverHold(context);
    final String label = tapInstead ? strings.onboardingTryTap : strings.onboardingTryHold;

    return Column(
      children: <Widget>[
        Semantics(
          button: true,
          label: label,
          child: GestureDetector(
            onTapDown: (TapDownDetails _) => _start(),
            onTapUp: (TapUpDetails _) => _stop(),
            onTapCancel: _stop,
            onTap: _tapped,
            child: AnimatedBuilder(
              animation: _progress,
              builder: (BuildContext context, Widget? child) => ClipRRect(
                borderRadius: BorderRadius.circular(AppRadius.button),
                child: Container(
                  height: 60,
                  decoration: BoxDecoration(
                    color: AppColors.blue.withValues(alpha: 0.10),
                    border: Border.all(color: AppColors.blue, width: 2),
                    borderRadius: BorderRadius.circular(AppRadius.button),
                  ),
                  child: Stack(
                    children: <Widget>[
                      // Fills from the left while held; without visible
                      // progress there is no telling how long to hold.
                      FractionallySizedBox(
                        widthFactor: _progress.value,
                        alignment: Alignment.centerLeft,
                        child: ColoredBox(
                          color: AppColors.blue.withValues(alpha: 0.28),
                          child: const SizedBox.expand(),
                        ),
                      ),
                      Center(
                        child: _holding
                            ? Row(
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  const SpeakingWave(active: true, height: 22),
                                  const SizedBox(width: AppSpacing.sm),
                                  Text(
                                    strings.onboardingTryHolding,
                                    style: Theme.of(
                                      context,
                                    ).textTheme.titleMedium?.copyWith(color: AppColors.blue),
                                  ),
                                ],
                              )
                            : Text(
                                label,
                                style: Theme.of(
                                  context,
                                ).textTheme.titleMedium?.copyWith(color: AppColors.blue),
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        SizedBox(
          height: 28,
          child: Center(
            child: AnimatedOpacity(
              opacity: _showHint ? 1 : 0,
              duration: AppMotion.decorative(context, AppDurations.reaction),
              child: Text(strings.onboardingTryHint, style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
        ),
      ],
    );
  }
}
