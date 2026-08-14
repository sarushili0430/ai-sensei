import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import 'onboarding_karte_preview.dart';
import 'onboarding_rehearsal.dart';

/// Onboarding: four pages, first launch only.
///
/// Page one is a promise, not a feature. The promise changed from "we don't give
/// you the answer" to "we teach you, then you teach it back", but the intent of
/// leading with a promise is unchanged (teaching alone would look like any free
/// AI, so both halves form one promise). Page two shows the whole core loop:
/// nobody opens the camera without knowing what the time is for.
///
/// Pages three and four are for doing it. A promise does not land by reading —
/// the more words are added, the further away it gets. So instead of more
/// explanation, they run one full round: taught, teach back (or fail to), and it
/// lands in the karte. The script is fixed and uses neither photos nor voice, so
/// no permissions are needed yet.
///
/// No permissions are requested here. Camera comes just before shooting, mic
/// just before the conversation, notifications just after a gap appears in the
/// first karte — each in context, so the biggest cause of first-run drop-off is
/// not stacked up front.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final PageController _controller = PageController();
  int _page = 0;
  RehearsalOutcome? _outcome;

  static const int _pageCount = 4;

  /// The rehearsal page — the only one where the next button waits on input.
  static const int _rehearsalPage = 2;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _isLast => _page == _pageCount - 1;

  /// The rehearsal wants either "explain" or "I can't say it". Both advance, so
  /// it is never a dead end, and "skip" above always exits.
  bool get _canAdvance => _page != _rehearsalPage || _outcome != null;

  Future<void> _next() async {
    if (_isLast) {
      await _finish();
      return;
    }

    // With reduced motion, switch without the page turn (`nextPage` rejects a
    // zero duration).
    final Duration duration = AppMotion.decorative(context, AppDurations.reaction);
    if (duration == Duration.zero) {
      _controller.jumpToPage(_page + 1);
      return;
    }
    await _controller.nextPage(duration: duration, curve: AppCurves.enter);
  }

  Future<void> _finish() async {
    await markOnboardingSeen(ref.read(preferencesProvider));
    if (mounted) context.go(AppRoute.home.path);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    final List<Widget> pages = <Widget>[
      const _PromisePage(),
      const _HowItWorksPage(),
      OnboardingRehearsalPage(
        outcome: _outcome,
        onOutcome: (RehearsalOutcome? outcome) => setState(() => _outcome = outcome),
      ),
      OnboardingKartePreviewPage(outcome: _outcome),
    ];

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: <Widget>[
            SizedBox(
              height: 40,
              child: Align(
                alignment: Alignment.centerRight,
                // The promise (page 1) and the loop (page 2) cannot be skipped:
                // expectation setting lives on those two, so the exit appears
                // only from the later pages.
                child: AnimatedOpacity(
                  opacity: _page >= _rehearsalPage ? 1 : 0,
                  duration: AppMotion.decorative(context, AppDurations.reaction),
                  child: TextButton(
                    onPressed: _page >= _rehearsalPage ? _finish : null,
                    style: TextButton.styleFrom(foregroundColor: AppColors.inkMuted),
                    child: Text(strings.onboardingSkip),
                  ),
                ),
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _controller,
                itemCount: pages.length,
                onPageChanged: (int page) => setState(() => _page = page),
                itemBuilder: (BuildContext context, int index) =>
                    _PageTransition(controller: _controller, index: index, child: pages[index]),
              ),
            ),
            _Dots(count: _pageCount, current: _page),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.md,
                AppSpacing.lg,
                AppSpacing.lg,
              ),
              child: ChunkyButton(
                label: _isLast ? strings.onboardingCta : strings.onboardingNext,
                onPressed: _canAdvance ? _next : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shrinks and fades the neighbouring page while turning.
///
/// Purely so the horizontal movement is felt under the finger; it has no effect
/// at rest, which is what goldens capture.
class _PageTransition extends StatelessWidget {
  const _PageTransition({required this.controller, required this.index, required this.child});

  final PageController controller;
  final int index;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (AppMotion.isReduced(context)) return child;

    return AnimatedBuilder(
      animation: controller,
      builder: (BuildContext context, Widget? child) {
        // No dimensions on the first build; treat that as at rest.
        final double page = controller.hasClients && controller.position.haveDimensions
            ? (controller.page ?? index.toDouble())
            : index.toDouble();
        final double distance = (page - index).abs().clamp(0.0, 1.0);

        return Opacity(
          opacity: 1 - 0.5 * distance,
          child: Transform.scale(scale: 1 - 0.05 * distance, child: child),
        );
      },
      child: child,
    );
  }
}

/// Page 1 — the promise.
///
/// Moved from a `Spacer`-centred `Column` to [CenteredScroll]. The revised
/// promise has two beats and runs long: in English it fills a 375pt screen with
/// the heading alone and overflows (measured). An overflowing `Column` clips its
/// children, so this matches pages 3 and 4: centred when it fits, scrolling when
/// it does not.
class _PromisePage extends StatelessWidget {
  const _PromisePage();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return CenteredScroll(
      children: <Widget>[
        // `puzzled` was the learner's expression. With senpai teaching, this is
        // the teacher's face, so it waits instead. Reworking the face widget
        // itself is cross-cutting and tracked separately.
        const FadeSlideIn(
          child: Center(child: SenpaiFace(mood: SenpaiMood.neutral, size: 140)),
        ),
        const SizedBox(height: AppSpacing.xl),
        FadeSlideIn.staggered(
          index: 1,
          child: Text(
            strings.onboardingTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.displaySmall,
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        FadeSlideIn.staggered(
          index: 2,
          child: Text(
            strings.onboardingBody,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      ],
    );
  }
}

/// Page 2 — the whole core loop, plus a heads-up about permissions.
///
/// The four lines: shoot, senpai teaches on the board, you teach it back, where
/// you stopped is kept as a gap. Line four is the crux — if it degrades into
/// "notes on what you asked", the whole basis for the 1/3/7-day revisits goes
/// with it.
class _HowItWorksPage extends StatelessWidget {
  const _HowItWorksPage();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    // [CenteredScroll] for the same reason as page 1: with longer step text,
    // English on a small screen cut off from line four (where gaps come from)
    // onwards — and that last line is exactly the one that must not be cut.
    return CenteredScroll(
      children: <Widget>[
        FadeSlideIn(
          child: Text(
            strings.onboardingHowTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const SizedBox(height: AppSpacing.xl),
        _Step(index: 1, icon: Icons.photo_camera_outlined, label: strings.onboardingStepCapture),
        // Step two is teaching while writing. The nib icon makes the board read
        // as a move in the loop rather than decoration, from the first line.
        _Step(index: 2, icon: Icons.draw_outlined, label: strings.onboardingStepTaught),
        _Step(index: 3, icon: Icons.mic_none_outlined, label: strings.onboardingStepExplain),
        _Step(index: 4, icon: Icons.description_outlined, label: strings.onboardingStepKarte),
        // No longer pushed to the bottom with `Spacer` (unusable inside a scroll
        // view). The permissions note sits right below the steps, as part of the
        // same block.
        const SizedBox(height: AppSpacing.lg),
        Text(
          strings.onboardingPermissionNote,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.index, required this.icon, required this.label});

  final int index;
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    // Only the fourth is recolored, marking it as what you take away.
    final bool isLast = index == 4;
    final Color tint = isLast ? AppColors.hole : AppColors.blue;

    return FadeSlideIn.staggered(
      index: index,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Column(
              children: <Widget>[
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: tint.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(AppRadius.button),
                  ),
                  child: Icon(icon, size: 20, color: tint),
                ),
                // The line to the next step, showing the loop vertically.
                if (!isLast) Expanded(child: Container(width: 2, color: AppColors.border)),
              ],
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: AppSpacing.md),
                child: Text(label, style: Theme.of(context).textTheme.bodyLarge),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.current});

  final int count;
  final int current;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < count; i++)
          AnimatedContainer(
            duration: AppMotion.decorative(context, AppDurations.reaction),
            curve: AppCurves.enter,
            margin: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
            width: i == current ? 20 : 8,
            height: 8,
            decoration: BoxDecoration(
              // Visited pages stay faint, so how many remain is visible.
              color: switch (i) {
                _ when i == current => AppColors.blue,
                _ when i < current => AppColors.blue.withValues(alpha: 0.35),
                _ => AppColors.border,
              },
              borderRadius: BorderRadius.circular(AppRadius.chip),
            ),
          ),
      ],
    );
  }
}
