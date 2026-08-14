import 'package:flutter/material.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import 'onboarding_rehearsal.dart';

/// Onboarding page 4 — the rehearsal comes back as a karte.
///
/// This is the first sight of what you take away. What was taught back or got
/// stuck on page 3 remains as a line, so the karte reads as your own record.
/// That it is not a summary of what was taught is the point of this page:
/// questions come from what the user explained, never from what the AI said.
///
/// Anyone who skipped the rehearsal sees both colors as a sample. We never write
/// something they did not do as though they did.
class OnboardingKartePreviewPage extends StatelessWidget {
  const OnboardingKartePreviewPage({required this.outcome, super.key});

  final RehearsalOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return CenteredScroll(
      children: <Widget>[
        const SizedBox(height: AppSpacing.md),
        FadeSlideIn(
          child: Text(
            strings.onboardingKarteTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        FadeSlideIn.staggered(index: 1, child: _KarteCard(outcome: outcome)),
        const SizedBox(height: AppSpacing.md),
        FadeSlideIn.staggered(
          index: 2,
          child: Text(
            strings.onboardingKarteBody,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        const SizedBox(height: AppSpacing.xl),
        FadeSlideIn.staggered(
          index: 3,
          child: Text(
            strings.onboardingReviewTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        const _ReviewTimeline(),
        const SizedBox(height: AppSpacing.xl),
        Text(
          strings.onboardingPermissionNote,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
      ],
    );
  }
}

class _KarteCard extends StatelessWidget {
  const _KarteCard({required this.outcome});

  final RehearsalOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // After a rehearsal, just that one line; otherwise both, as a sample.
    final List<(String, String, MarkerColor)> lines = switch (outcome) {
      RehearsalOutcome.explained => <(String, String, MarkerColor)>[
        (strings.karteSaidWell, strings.onboardingTrySaid, MarkerColor.said),
      ],
      RehearsalOutcome.passed => <(String, String, MarkerColor)>[
        (strings.karteHoles(1), strings.onboardingTryHole, MarkerColor.hole),
      ],
      null => <(String, String, MarkerColor)>[
        (strings.karteSaidWell, strings.onboardingTrySaid, MarkerColor.said),
        (strings.karteHoles(1), strings.onboardingTryHole, MarkerColor.hole),
      ],
    };

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
          Text(strings.karteTitle, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.sm),
          for (int i = 0; i < lines.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: AppSpacing.md),
            Text(lines[i].$1, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.xs),
            // Drawn top down, so the order of writing is visible.
            MarkerText(
              lines[i].$2,
              marker: lines[i].$3,
              delay: AppDurations.reaction + AppDurations.draw * i,
            ),
          ],
        ],
      ),
    );
  }
}

/// Tomorrow, in 3 days, in 7 days. Spaced repetition is itself the product
/// feature, so it is shown with a line and dots rather than explained in words.
///
/// Kept after the pivot. The revisit now starts from the quiz, but the questions
/// still come from what the student explained, so these are not bolted-on
/// notifications. Free vs paid is not claimed here — the 1/3/7-day notifications
/// carry no marginal cost and sit on the free tier.
class _ReviewTimeline extends StatelessWidget {
  const _ReviewTimeline();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final List<String> labels = <String>[
      strings.onboardingReviewTomorrow,
      strings.onboardingReviewDay3,
      strings.onboardingReviewDay7,
    ];

    return Column(
      children: <Widget>[
        SizedBox(
          height: 16,
          child: TweenAnimationBuilder<double>(
            tween: Tween<double>(begin: 0, end: 1),
            duration: AppMotion.decorative(context, AppDurations.celebrate),
            curve: AppCurves.enter,
            builder: (BuildContext context, double progress, Widget? child) =>
                CustomPaint(painter: _TimelinePainter(progress), size: Size.infinite),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Row(
          children: <Widget>[
            for (int i = 0; i < labels.length; i++)
              Expanded(
                child: FadeSlideIn(
                  delay: AppDurations.stagger * (i * 2),
                  offset: 6,
                  child: Text(
                    labels[i],
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _TimelinePainter extends CustomPainter {
  const _TimelinePainter(this.progress);

  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    // Dots at 1/6, 3/6 and 5/6, aligned to the centres of the three labels.
    final List<double> stops = <double>[size.width / 6, size.width / 2, size.width * 5 / 6];
    final double y = size.height / 2;
    final double head = stops.first + (stops.last - stops.first) * progress;

    canvas.drawLine(
      Offset(stops.first, y),
      Offset(head, y),
      Paint()
        ..color = AppColors.border
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round,
    );

    for (final double x in stops) {
      if (x > head + 0.5) continue;
      canvas.drawCircle(Offset(x, y), 5, Paint()..color = AppColors.hole);
    }
  }

  @override
  bool shouldRepaint(_TimelinePainter oldDelegate) => oldDelegate.progress != progress;
}
