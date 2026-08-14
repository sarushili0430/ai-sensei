import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../monetization/presentation/manage_subscription_button.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// Home. A hub, not a shutter button.
///
/// - Counts only streak days and filled gaps; no XP, levels or rankings
/// - Two entrances: today's move ([_PrimaryAction]) and yesterday's thread
///   ([_OpenHolesCard])
/// - Always exactly one action at the bottom — swap its contents, never stack
/// - No usage counts; the limit is shown as senpai's judgement, in prose
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ProgressSummary> summary = ref.watch(progressControllerProvider);
    final ProgressSummary data = summary.value ?? ProgressSummary.empty;

    // Senpai has decided there are no more lessons today. Better to say so here
    // than to refuse after the photo. When progress is unavailable `unknown` is
    // true, so the entrance is never blocked.
    final bool enoughForToday = !data.limits.lessonAllowedToday;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              FadeSlideIn(child: _TopRow(progress: data.progress)),
              // The face and greeting are the reading area: centred when it
              // fits, and the only part that moves when it does not.
              //
              // Two `Spacer`s used to centre this, but longer copy pushed the
              // action below off screen (measured: the English "that's it for
              // today" line overflowed at 375x667). An overflowing `Column`
              // clips its children, producing an unreachable button. When it
              // fits, this looks identical to `Spacer`.
              Expanded(
                child: CenteredScroll(
                  padding: EdgeInsets.zero,
                  children: <Widget>[
                    const FadeSlideIn(
                      // The face now announces "senpai is waiting" itself, so
                      // the wrapper label here was removed rather than
                      // maintaining the same wording twice.
                      child: Center(child: SenpaiFace(mood: SenpaiMood.neutral, size: 140)),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    FadeSlideIn.staggered(
                      index: 1,
                      child: Text(
                        // On a closed-out day the greeting shifts from a
                        // question to thanks. Asking "where did you get stuck?"
                        // and then refusing the photo contradicts itself.
                        enoughForToday ? strings.homeGreetingDone : strings.homeGreeting,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              FadeSlideIn.staggered(index: 2, child: _OpenHolesCard(progress: data.progress)),
              const SizedBox(height: AppSpacing.md),
              FadeSlideIn.staggered(
                index: 3,
                child: _PrimaryAction(
                  enoughForToday: enoughForToday,
                  hasOpenHoles: data.progress.openHoles > 0,
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              FadeSlideIn.staggered(
                index: 4,
                child: _EnoughForTodayLine(
                  show: enoughForToday,
                  showUpgrade: !data.isPremium,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Today's move, always in the same place at the bottom.
///
/// Swapped, never stacked: two buttons would make color the only way to tell
/// which one is live.
///
/// | State | Label | Destination |
/// | --- | --- | --- |
/// | lesson available | learn from senpai | capture (`push` — cancel returns) |
/// | closed out, gaps open | a gap to fill | review (free, no marginal cost) |
/// | closed out, no gaps | learn from senpai (disabled) | — |
///
/// Closed-out days point at review so hitting the limit does not end the path.
class _PrimaryAction extends StatelessWidget {
  const _PrimaryAction({required this.enoughForToday, required this.hasOpenHoles});

  final bool enoughForToday;
  final bool hasOpenHoles;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    if (enoughForToday && hasOpenHoles) {
      return ChunkyButton(
        key: const ValueKey<String>('home-primary-review'),
        label: strings.reviewTitle,
        onPressed: () => context.push(AppRoute.review.path),
      );
    }

    return ChunkyButton(
      key: const ValueKey<String>('home-primary-lesson'),
      label: strings.homeLesson,
      onPressed: enoughForToday ? null : () => context.push(AppRoute.capture.path),
    );
  }
}

class _TopRow extends StatelessWidget {
  const _TopRow({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Row(
      children: <Widget>[
        // The two things we count. This side owns the slack, so no Spacer.
        //
        // The Premium chip alongside can overflow narrow screens. Something
        // that stays readable when shrunk should not become RenderFlex stripes:
        // scaleDown never enlarges, so it changes nothing when it fits and only
        // shrinks when it does not.
        Expanded(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Row(
              children: <Widget>[
                _Counter(
                  value: progress.streakDays,
                  label: strings.streakDays(progress.streakDays),
                  color: AppColors.streak,
                ),
                const SizedBox(width: AppSpacing.md),
                _Counter(
                  value: progress.filledHoles,
                  label: strings.filledHoles(progress.filledHoles),
                  color: AppColors.blue,
                  tooltip: strings.parentReportOpen,
                  onTap: () => context.push(AppRoute.parentReport.path),
                ),
              ],
            ),
          ),
        ),
        // The subscribed marker; renders nothing without a subscription.
        const PremiumChip(),
      ],
    );
  }
}

/// Yesterday's thread: the start of a return visit, and the notification's
/// landing spot.
///
/// With no gaps it says "it starts with your first photo" instead, so home on
/// first launch is not blank with nothing to press.
///
/// On a closed-out day the [_PrimaryAction] just below leads to the same review
/// screen. The overlap is deliberate: this card explains what is left, the
/// button does it, and they read in that order.
///
/// The gap count is never shown — a number of unfinished items makes gaps look
/// like debt rather than assets. Even with several, only the most recent one is
/// shown, since knowing what comes next is enough.
class _OpenHolesCard extends ConsumerWidget {
  const _OpenHolesCard({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    if (progress.openHoles == 0) {
      return Text(
        strings.homeFirstRun,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall,
      );
    }

    // The just-written karte is also a candidate, so content shows before the
    // queue loads or when it fails. A gap present in both changes nothing: the
    // pick is by date and stays a single entry.
    final ReviewQueue? queue = ref.watch(reviewControllerProvider).value;
    final Karte? latestKarte = ref.watch(latestKarteControllerProvider);
    final Hole? recentHole = _mostRecentOpenHole(queue, latestKarte);

    return GestureDetector(
      onTap: () => context.push(AppRoute.review.path),
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.card),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: <Widget>[
            Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(color: AppColors.hole, shape: BoxShape.circle),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(strings.reviewTitle, style: Theme.of(context).textTheme.titleMedium),
                  Text(
                    recentHole?.description ?? strings.homeOpenHoleLabel,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: AppColors.inkMuted),
          ],
        ),
      ),
    );
  }

  Hole? _mostRecentOpenHole(ReviewQueue? queue, Karte? latestKarte) {
    Hole? mostRecent;
    final List<Hole> candidates = <Hole>[
      if (queue != null)
        for (final ReviewQueueItem item in queue.items) item.hole,
      if (latestKarte != null) ...latestKarte.holes,
    ];

    for (final Hole hole in candidates) {
      if (hole.status != HoleStatus.open) continue;
      if (mostRecent == null || hole.createdAt.isAfter(mostRecent.createdAt)) {
        mostRecent = hole;
      }
    }
    return mostRecent;
  }
}

/// "That's it for today" — senpai's judgement.
///
/// This used to show "1 free session left today". Usage counts were dropped:
///   - a number turns the limit from a teacher's call into a restriction
///   - seeing the remainder makes people budget it, giving them a reason to save
///     today's most pressing question for tomorrow
///   - it is tuned never to fire in normal use (1-2 lessons a day), so there is
///     usually no number to show anyway
///
/// While anything remains, nothing is shown at all — even "you're fine for now"
/// hints at a remainder. It appears only once senpai closes the day. Free users
/// also get a path to subscribing; the Premium fair-use limit does not stack a
/// billing prompt onto someone who already pays.
///
/// The greeting already changed to [AppStrings.homeGreetingDone] on such days,
/// so this stays strictly explanatory and does not repeat it.
class _EnoughForTodayLine extends StatelessWidget {
  const _EnoughForTodayLine({required this.show, required this.showUpgrade});

  final bool show;
  final bool showUpgrade;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // Reserve the height even when empty, so the button does not jump when the
    // day closes out.
    if (!show) return const SizedBox(height: AppSpacing.md);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          strings.lessonEnoughForToday,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (showUpgrade)
          TextButton(
            onPressed: () => context.push(AppRoute.paywall.path),
            style: TextButton.styleFrom(
              foregroundColor: AppColors.blue,
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
            ),
            child: Text(strings.homeUnlock, style: Theme.of(context).textTheme.bodySmall),
          ),
      ],
    );
  }
}

class _Counter extends StatelessWidget {
  const _Counter({
    required this.value,
    required this.label,
    required this.color,
    this.tooltip,
    this.onTap,
  });

  final int value;
  final String label;
  final Color color;
  final String? tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final Widget counter = Semantics(
      label: label,
      button: onTap != null,
      child: GestureDetector(
        key: onTap == null ? null : const ValueKey<String>('parent-report-link'),
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Row(
          children: <Widget>[
            // The only two things counted: streak days and filled gaps. They
            // count up from 0 so the increase is visible.
            CountUpText(
              value,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(color: color),
            ),
            const SizedBox(width: AppSpacing.xs),
            Text(label, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );

    // A new card on home would push today's move down on narrow screens. The
    // report's headline metric, filled gaps, doubles as the entrance instead of
    // adding a visible third counter. Tooltip and button semantics convey the
    // destination on long press and to screen readers.
    final String? message = tooltip;
    return message == null ? counter : Tooltip(message: message, child: counter);
  }
}
