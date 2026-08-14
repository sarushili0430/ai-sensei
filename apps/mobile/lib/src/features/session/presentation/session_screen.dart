import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../application/board_inbox.dart';
import '../application/session_controller.dart';
import '../domain/session.dart';
import 'board/board_style.dart';
import 'board/board_view.dart';

/// The conversation screen (wireframes 03 and 04 merged into one).
///
/// A lively screen, but never an examiner's UI.
///
/// It has two forms, split only by whether a board has arrived:
///
///   - no board (existing review conversations): senpai's expression leads, and
///     text is a modest caption
///   - board (lesson mode): the board leads, with face and captions small in a
///     bottom bar. Even during teach-back (`explainBack`) the board stays and
///     "explain it" appears below
///
/// The board stacks line by line and never erases. It clears only when moving to
/// another problem (`board_open`), and that decision belongs to the receiver
/// ([BoardInbox]).
class SessionScreen extends ConsumerStatefulWidget {
  const SessionScreen({super.key});

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final SessionStart? session = ref.read(captureControllerProvider).session;
      if (session == null) {
        context.go(AppRoute.home.path);
        return;
      }
      ref.read(sessionControllerProvider.notifier).connect(
            session,
            locale: Localizations.localeOf(context).languageCode,
          );
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final SessionState state = ref.watch(sessionControllerProvider);

    ref.listen<SessionState>(sessionControllerProvider, (SessionState? previous, SessionState next) {
      if (next.phase == SessionPhase.finished) {
        context.go(AppRoute.celebration.path);
      }
    });

    // When the conversation never started, do not sit silently on face and
    // captions: say what happened and what can be done next.
    if (state.phase == SessionPhase.failed) {
      return _SessionFailed(failure: state.failure);
    }

    final String subtitle = switch (state.phase) {
      SessionPhase.connecting => strings.sessionConnecting,
      SessionPhase.summarizing || SessionPhase.finished => strings.sessionSummarizing,
      // In a lesson the caption is senpai's speech. Before anything is said,
      // show what is happening rather than "listening".
      SessionPhase.senpaiTeaching => state.lastSenpaiText ?? strings.sessionSenpaiTeaching,
      _ => state.lastSenpaiText ?? strings.sessionListening,
    };

    // The conversation is over and only the karte is pending. Leaving the button
    // enabled here invites repeated taps that do nothing.
    final bool wrappingUp =
        state.phase == SessionPhase.summarizing || state.phase == SessionPhase.finished;

    final BoardSnapshot board = state.board;
    // The problem the analysis could read; `null` when it could not, and then
    // nothing is shown — "could not read the problem" would send students off to
    // retake before senpai even asks them to read it out.
    final SessionProblem? problem = ref.watch(captureControllerProvider).analysis?.problem;

    return Scaffold(
      body: SafeArea(
        // Horizontal padding is applied per child: only the board runs edge to
        // edge, because it is a surface rather than a card (`board_view.dart`).
        // Wrapping everything would leave the board floating like a notice, and
        // inner padding would drop the effective width below 340pt and push
        // formulas into horizontal scrolling.
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
          child: Column(
            children: <Widget>[
              _Inset(
                child: _SessionHeader(
                  title: board.title,
                  remaining: strings.remaining(state.remainingSeconds),
                ),
              ),
              // The problem text always sits above the board. The heading
              // (`board.title`) is senpai's summary, not the problem itself, and
              // without the problem on screen the only way to know what is being
              // solved is to reverse-engineer the board.
              if (problem != null) ...<Widget>[
                const SizedBox(height: AppSpacing.sm),
                _Inset(child: _ProblemBlock(text: problem.text)),
              ],
              if (board.hasBoard) ...<Widget>[
                const SizedBox(height: AppSpacing.md),
                // The board leads; give it all the remaining height.
                Expanded(child: _BoardStage(board: board)),
                const SizedBox(height: AppSpacing.md),
                _Inset(child: _LessonFooter(phase: state.phase, wrappingUp: wrappingUp)),
              ] else
                // Captions only when there is no board.
                //
                // Their rationale was following the conversation where audio
                // cannot be heard, but this app is built on teaching back, which
                // does not work anywhere you cannot speak. With a board up, what
                // to read is on the board.
                //
                // On board-less paths (a recovery after board failure, review on
                // an older API) senpai's words are the only cue on screen, so
                // captions stay there.
                //
                // The height is one box that scrolls inside. Sandwiched between
                // `Spacer`s, a long reply pushed the controls off screen (BOTTOM
                // OVERFLOWED landed on "done for today" on device).
                Expanded(
                  child: CenteredScroll(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                    children: <Widget>[
                      SenpaiFace(
                        mood: switch (state.phase) {
                          SessionPhase.connecting => SenpaiMood.neutral,
                          SessionPhase.listening ||
                          SessionPhase.explainBack => SenpaiMood.listening,
                          SessionPhase.senpaiSpeaking ||
                          SessionPhase.senpaiTeaching => SenpaiMood.neutral,
                          SessionPhase.summarizing => SenpaiMood.neutral,
                          SessionPhase.finished => SenpaiMood.delighted,
                          // The puzzled face appears only when we failed (see
                          // `SenpaiMood.puzzled`), never when a student is stuck.
                          SessionPhase.failed => SenpaiMood.puzzled,
                        },
                        size: 160,
                      ),
                      const SizedBox(height: AppSpacing.md),
                      _StatusIndicator(phase: state.phase, wrappingUp: wrappingUp),
                      const SizedBox(height: AppSpacing.md),
                      // Switch per sentence so the swap is visible.
                      _Subtitle(text: subtitle, align: TextAlign.center),
                    ],
                  ),
                ),
              // Passing is not shameful; it is a valuable record of a gap.
              _Inset(
                child: GhostButton(
                  label: strings.sessionPass,
                  onPressed: wrappingUp
                      ? null
                      : () => ref
                          .read(sessionControllerProvider.notifier)
                          .pass(strings.sessionPassMessage),
                ),
              ),
              _Inset(
                child: ChunkyButton(
                  label: wrappingUp ? strings.sessionSummarizing : strings.sessionEnd,
                  color: AppColors.border,
                  foregroundColor: AppColors.ink,
                  // Disabled the moment it is tapped, with wording and color
                  // both showing it was received.
                  onPressed: wrappingUp
                      ? null
                      : () => ref.read(sessionControllerProvider.notifier).finish(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Top bar: the time left and, with a board, its heading (which problem it is).
class _SessionHeader extends StatelessWidget {
  const _SessionHeader({required this.title, required this.remaining});

  final String? title;
  final String remaining;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        if (title != null)
          Expanded(
            child: Text(
              title!,
              style: Theme.of(context).textTheme.titleMedium,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          )
        else
          const Spacer(),
        Text(remaining, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

/// The problem being solved, pinned above the board for the whole lesson.
///
/// The board grows, so a problem inside the scroll would leave the screen at
/// once — yet the problem is exactly what people most want to re-read while
/// teaching back, so it is fixed here instead of scrolling.
///
/// Capped at three lines. The contract allows 600 characters
/// (`problemTextMaxLength`), and showing all of it would push the board off
/// screen. Capture shows the full text and scrolls around it, but the same trick
/// does not work here, where what gets pushed out is the board. Expanded, it
/// stops at eight lines so the board stays visible.
class _ProblemBlock extends StatefulWidget {
  const _ProblemBlock({required this.text});

  final String text;

  @override
  State<_ProblemBlock> createState() => _ProblemBlockState();
}

class _ProblemBlockState extends State<_ProblemBlock> {
  static const int _collapsedLines = 3;
  static const int _expandedLines = 8;

  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final TextStyle? body = Theme.of(context).textTheme.bodyMedium;

    return DecoratedBox(
      decoration: BoxDecoration(
        // A different material from the board: the problem is paper (white), the
        // board sits directly on the ground. The roles read without labels
        // because the surfaces differ, not the words.
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              strings.sessionProblemTitle,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.inkMuted),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              widget.text,
              style: body,
              maxLines: _expanded ? _expandedLines : _collapsedLines,
              overflow: TextOverflow.ellipsis,
            ),
            // Make the expand affordance visible: an ellipsis alone shows there
            // is more but not how to reach it. Hidden for short problems.
            if (_isTruncated(context, body))
              GestureDetector(
                onTap: () => setState(() => _expanded = !_expanded),
                child: Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.xs),
                  child: Text(
                    _expanded ? strings.sessionProblemCollapse : strings.sessionProblemExpand,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.blue),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Whether the body overflows when collapsed. Measured by actually laying it
  /// out: a character count would hide "read more" on newline-heavy problems.
  bool _isTruncated(BuildContext context, TextStyle? style) {
    final double width = MediaQuery.sizeOf(context).width - AppSpacing.lg * 2 - AppSpacing.md * 2;
    if (width <= 0) return false;
    final TextPainter painter = TextPainter(
      text: TextSpan(text: widget.text, style: style),
      maxLines: _collapsedLines,
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout(maxWidth: width);
    final bool overflows = painter.didExceedMaxLines;
    painter.dispose();
    return overflows;
  }
}

/// The board during a lesson: the screen's lead, stacking line by line.
///
/// On width: the 70% minimum scale in `board_style.dart` was measured against an
/// effective width of 340pt (iPhone 15's 393pt minus board padding). This
/// screen's horizontal padding is `AppSpacing.lg` x 2 = 48pt, giving 345pt —
/// near enough. Adding a card or inner padding would drop the effective width
/// below that premise and push formulas that measured as fitting into horizontal
/// scrolling. The right-edge fade in `latex_element_view.dart` also assumes the
/// board sits directly on `AppColors.background` (the Scaffold's ground).
///
/// The `CrossAxisAlignment.stretch` in [build] specifies effective width, not
/// appearance. With `start`, the board's `Column` shrinks to the intrinsic width
/// of its longest line and [LatexElementView] judges the scale against that
/// shrunken width. It happened for real on a screen showing the board outside a
/// lesson (345pt intended, 198pt measured — a bigger factor than card padding),
/// so do not "tidy" it back to `start`. The guard is the effective-width test in
/// `test/session_board_test.dart`.
class _BoardStage extends StatefulWidget {
  const _BoardStage({required this.board});

  final BoardSnapshot board;

  @override
  State<_BoardStage> createState() => _BoardStageState();
}

class _BoardStageState extends State<_BoardStage> {
  final ScrollController _controller = ScrollController();

  /// Slack for counting as "at the bottom". An exact match is not required:
  /// formula measurement lands a frame late, so a few pt of drift is normal.
  static const double _followSlack = 48;

  @override
  void didUpdateWidget(_BoardStage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.board.steps.length == oldWidget.board.steps.length) return;

    // Never yank someone back while they are scrolled up reading. The board's
    // value is being able to look back at a moment you missed, and letting new
    // lines steal that look-back destroys the value.
    if (!_isAtBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => _followNewLine());
  }

  bool get _isAtBottom {
    if (!_controller.hasClients) return true;
    final ScrollPosition position = _controller.position;
    return position.pixels >= position.maxScrollExtent - _followSlack;
  }

  void _followNewLine() {
    if (!mounted || !_controller.hasClients) return;
    final double bottom = _controller.position.maxScrollExtent;
    if (AppMotion.isReduced(context)) {
      _controller.jumpTo(bottom);
      return;
    }
    _controller.animateTo(bottom, duration: AppDurations.draw, curve: AppCurves.enter);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The board does not move; the chalk does.
    //
    // Putting the surface only inside [BoardView] (the scrolling side) shrinks
    // it to the content height, so a lesson with one or two lines ends the board
    // partway down the screen, and its edges scroll with the content — black
    // paper rather than a blackboard. Laying it across the lesson's full height
    // here keeps it a board whatever has been written.
    return ColoredBox(
      color: BoardStyle.surface,
      child: SingleChildScrollView(
        controller: _controller,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            BoardView(steps: widget.board.steps),
            if (widget.board.hasGap) const _BoardGapNotice(),
          ],
        ),
      ),
    );
  }
}

/// The line announcing a truncated board.
///
/// A hole-riddled board is never shown silently (see `BoardContractViolation` in
/// `domain/board.dart`): a student cannot tell something is missing and would
/// learn it wrong. It must not look accusatory, though — we dropped it, and the
/// student did nothing wrong. It also avoids the gap color (`AppColors.hole`),
/// which means a learning gap still to fill, not a delivery failure.
class _BoardGapNotice extends StatelessWidget {
  const _BoardGapNotice();

  @override
  Widget build(BuildContext context) {
    // Written on the board, so it uses chalk. Left as ink it would be black on
    // black, leaving the one line about the truncation unreadable. This is
    // outside [BoardView], so the same horizontal padding is applied here.
    return Padding(
      padding: const EdgeInsets.fromLTRB(BoardView.padding, 0, BoardView.padding, AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Divider(color: BoardStyle.chalkMuted, height: AppSpacing.lg),
          Text(
            AppStrings.of(context).sessionBoardGap,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: BoardStyle.chalkMuted,
                ),
          ),
        ],
      ),
    );
  }
}

/// The bottom bar during a lesson: whose turn it is, without erasing the board.
///
/// No captions. While a board is up, what to read is the board. Streaming
/// senpai's speech here would bring back in text the explanation we moved to the
/// board, giving the screen two leads (on device, four paragraphs of transcript
/// sat under the figure and formula). This holds only whose turn it is.
class _LessonFooter extends StatelessWidget {
  const _LessonFooter({required this.phase, required this.wrappingUp});

  final SessionPhase phase;
  final bool wrappingUp;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final bool yourTurn = phase == SessionPhase.explainBack;

    return Row(
      children: <Widget>[
        // The face stays — having senpai beside you is the lesson experience —
        // but small, since the board leads.
        SenpaiFace(
          mood: yourTurn ? SenpaiMood.listening : SenpaiMood.neutral,
          size: 64,
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: Text(
            // One line, saying only whose turn it is.
            yourTurn && !wrappingUp
                ? strings.sessionExplainBack
                : wrappingUp
                    ? strings.sessionSummarizing
                    : strings.sessionSenpaiTeaching,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        _StatusIndicator(phase: phase, wrappingUp: wrappingUp),
      ],
    );
  }
}

/// The screen's horizontal padding. Only the board skips it and runs full width.
class _Inset extends StatelessWidget {
  const _Inset({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
      child: child,
    );
  }
}

/// Shows that we are listening (or writing the karte) ahead of the captions.
///
/// Nobody reads text while speaking, so it has to register peripherally. While
/// the karte is being written, this is where the wait is shown — leaving the
/// waveform up would suggest we are still listening.
class _StatusIndicator extends StatelessWidget {
  const _StatusIndicator({required this.phase, required this.wrappingUp});

  final SessionPhase phase;
  final bool wrappingUp;

  @override
  Widget build(BuildContext context) {
    if (wrappingUp) {
      return SizedBox(
        height: 26,
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(
              strokeWidth: 2.5,
              // No spinning under reduced motion; an arc that still reads as
              // work in progress (same treatment as SpeakingWave).
              value: AppMotion.isReduced(context) ? 0.25 : null,
            ),
          ),
        ),
      );
    }
    return SpeakingWave(
      active: phase == SessionPhase.listening || phase == SessionPhase.explainBack,
    );
  }
}

/// Captions, so the conversation can be followed where audio cannot be heard.
class _Subtitle extends StatelessWidget {
  const _Subtitle({required this.text, required this.align});

  final String text;
  final TextAlign align;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: AppMotion.decorative(context, AppDurations.reaction),
      child: Text(
        text,
        key: ValueKey<String>(text),
        textAlign: align,
        style: Theme.of(context).textTheme.bodyLarge,
      ),
    );
  }
}

/// The screen for a conversation that never started.
///
/// Give the reason and an exit. Left on "listening", people conclude their own
/// explanation was at fault.
class _SessionFailed extends ConsumerWidget {
  const _SessionFailed({required this.failure});

  final SessionFailure? failure;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final SessionStart? session = ref.watch(captureControllerProvider).session;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const SenpaiFace(mood: SenpaiMood.puzzled, size: 160),
              const SizedBox(height: AppSpacing.xl),
              Text(
                switch (failure) {
                  SessionFailure.senpaiUnavailable => strings.sessionSenpaiUnavailable,
                  SessionFailure.connection || null => strings.sessionConnectionFailed,
                },
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: AppSpacing.xl),
              if (session != null)
                ChunkyButton(
                  label: strings.sessionRetry,
                  onPressed: () => ref.read(sessionControllerProvider.notifier).retry(
                        session,
                        locale: Localizations.localeOf(context).languageCode,
                      ),
                ),
              GhostButton(
                label: strings.sessionBackHome,
                onPressed: () => context.go(AppRoute.home.path),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
