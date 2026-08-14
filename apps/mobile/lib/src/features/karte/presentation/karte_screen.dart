import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:permission_handler/permission_handler.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../notifications/application/push_controller.dart';
import '../../notifications/data/push_repository.dart';
import '../../session/presentation/board/board_view.dart';
import '../application/karte_controllers.dart';
import '../application/last_board_controller.dart';
import '../application/lesson_hole_candidate.dart';
import '../domain/karte.dart';
import '../domain/last_board.dart';
import 'hole_self_report_prompt.dart';

/// Karte screen.
///
/// - A quiet screen; none of the celebration screen's noise
/// - No scores. Gaps are shown as places still to fill
/// - Reading order: conclusion (said well, gaps, term notes), then evidence
///   ([_BoardSection]), then actions
/// - The board is not first because a long one would push the conclusion off
///   screen
class KarteScreen extends ConsumerWidget {
  const KarteScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Karte? karte = ref.watch(latestKarteControllerProvider);
    final SessionOutcome outcome = ref.watch(sessionOutcomeControllerProvider);
    final bool showPaywall = outcome.showPaywall;

    // Without a recent karte the router redirects home (app_router.dart), so
    // this runs for a single frame and shows no error copy.
    if (karte == null) {
      return Scaffold(
        appBar: AppBar(title: Text(strings.karteTitle)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(strings.karteTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: <Widget>[
            // Markers draw top down, in the order today's conversation was
            // written. Not sped up: this is a screen for reading back, and
            // rushing it feels restless.
            _Section(
              title: strings.karteSaidWell,
              children: <Widget>[
                for (int i = 0; i < karte.saidWell.length; i++)
                  MarkerText(
                    karte.saidWell[i],
                    marker: MarkerColor.said,
                    delay: AppDurations.draw * i,
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),
            _Section(
              title: strings.karteHoles(karte.holes.length),
              children: karte.holes.isEmpty
                  ? <Widget>[Text(strings.karteNoHoles)]
                  : <Widget>[
                      for (int i = 0; i < karte.holes.length; i++)
                        MarkerText(
                          karte.holes[i].description,
                          marker: MarkerColor.hole,
                          // Finish drawing what was said, then move to gaps.
                          delay: AppDurations.draw * (karte.saidWell.length + i),
                        ),
                    ],
            ),
            if (karte.termNotes.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _Section(
                title: strings.karteTermNotes,
                children: karte.termNotes
                    .map((String it) => Text(it, style: Theme.of(context).textTheme.bodyMedium))
                    .toList(growable: false),
              ),
            ],
            const _BoardSection(),
            if (karte.followupQuestion != null) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _FollowupCard(question: karte.followupQuestion!),
            ],
            if (outcome.isNewLesson) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _LessonHoleSelfReport(karte: karte),
            ],
            const SizedBox(height: AppSpacing.xl),
            if (karte.holes.isNotEmpty) const _ReviewReminderCard(),
            const SizedBox(height: AppSpacing.lg),
            if (karte.holes.isNotEmpty)
              ChunkyButton(
                label: strings.karteRetry,
                onPressed: () => context.push(AppRoute.review.path),
              ),
            GhostButton(
              label: strings.karteDone,
              // The paywall slots in here only just after a gap appears in the
              // first karte. The server decides whether to show it, and it never
              // reappears, so as not to nag.
              onPressed: () => context.go(
                showPaywall ? AppRoute.paywall.path : AppRoute.home.path,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Asks after the karte about past gaps only, and only ones overlapping this
/// lesson.
///
/// Not on the celebration screen: that one may still be receiving the karte, so
/// `said_well` — the basis for narrowing candidates — can be missing. Right
/// after reading the karte it is also clear what is being self-reported.
///
/// A failed queue fetch is silently skipped. Blocking today's karte to demand a
/// retry would turn an optional follow-up into a gate, and a gate into nagging.
class _LessonHoleSelfReport extends ConsumerStatefulWidget {
  const _LessonHoleSelfReport({required this.karte});

  final Karte karte;

  @override
  ConsumerState<_LessonHoleSelfReport> createState() => _LessonHoleSelfReportState();
}

class _LessonHoleSelfReportState extends ConsumerState<_LessonHoleSelfReport> {
  bool _dismissed = false;

  @override
  Widget build(BuildContext context) {
    if (_dismissed) return const SizedBox.shrink();

    final ReviewQueue? queue = ref.watch(reviewControllerProvider).value;
    if (queue == null) return const SizedBox.shrink();
    final ReviewQueueItem? candidate = selectLessonHoleCandidate(
      karte: widget.karte,
      queue: queue,
    );
    if (candidate == null) return const SizedBox.shrink();

    return HoleSelfReportPrompt(
      hole: candidate.hole,
      showLaterHint: true,
      // "Not yet" only closes the question on this karte. The gap and its
      // notifications remain, and review offers the same choice any time.
      onNotYet: () => setState(() => _dismissed = true),
      onFilled: () => setState(() => _dismissed = true),
    );
  }
}

/// The board senpai wrote; the only place it can be read back after the lesson.
///
/// - The conversation screen's board dies with AutoDispose; only
///   [LastBoardController] survives
/// - With no board, the heading is omitted too — an empty heading looks broken
/// - Not wrapped in a card (no border, no inner padding), for two reasons:
/// - `latexMinScale` (70%) was measured at an effective width of 340pt; a card
///   drops that to 311pt and formulas verified to fit start scrolling
///   horizontally, and only `debugPrint` would say so
/// - The right-edge fade assumes the board sits directly on
///   `AppColors.background`
/// - The heading marks this as the board, not a container (as in [_Section])
class _BoardSection extends ConsumerWidget {
  const _BoardSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final LastBoard board = ref.watch(lastBoardControllerProvider);
    if (board.isEmpty) return const SizedBox.shrink();

    return Column(
      // Not `start`: children would shrink to intrinsic width, lowering the
      // scale factor and adding horizontal scroll. `_BoardStage` in lesson mode
      // uses `stretch` for the same reason.
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: AppSpacing.lg),
        Align(
          alignment: Alignment.centerLeft,
          child: Text(
            strings.karteBoardTitle,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        BoardView(steps: board.steps),
        // The truncation marker goes below the board's last line — not beside
        // the heading or in a corner — so a reader reaching the end notices
        // there is no more ([LastBoard.truncated]).
        if (board.showsTruncation) ...<Widget>[
          const SizedBox(height: AppSpacing.sm),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              strings.karteBoardTruncated,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        for (final Widget child in children)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: Align(alignment: Alignment.centerLeft, child: child),
          ),
      ],
    );
  }
}

/// "May I ask again tomorrow night?"
///
/// The only place in the app that requests notification permission, and never
/// on first launch. Asking as a favour from senpai right after a gap is found
/// has real context, and even a refusal has conveyed the value of the 1/3/7-day
/// revisits.
///
/// There is no in-app switch because the OS permission is the state; holding it
/// twice creates "on in the app but nothing arrives".
class _ReviewReminderCard extends ConsumerWidget {
  const _ReviewReminderCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final PushPermission permission = ref.watch(pushPermissionControllerProvider);

    // In builds without notifications, show only the promise, quietly.
    final bool granted = permission.granted || !permission.available;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              granted ? strings.karteReviewToggle : strings.karteReviewAsk,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          if (permission.available)
            Switch(
              value: permission.granted,
              activeThumbColor: AppColors.blue,
              onChanged: (bool wantsOn) async {
                // Turning it off happens in system settings; no second switch.
                if (!wantsOn) {
                  await openAppSettings();
                  return;
                }
                final bool ok =
                    await ref.read(pushPermissionControllerProvider.notifier).request();
                if (ok || !context.mounted) return;
                // After one refusal iOS never shows the dialog again, so
                // explain how to reach settings.
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(strings.karteReviewDenied),
                    action: SnackBarAction(
                      label: strings.settingsNotificationsOpenSettings,
                      onPressed: openAppSettings,
                    ),
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}

/// Senpai's follow-up question (Premium).
class _FollowupCard extends StatelessWidget {
  const _FollowupCard({required this.question});

  final String question;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.blue.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.card),
      ),
      child: Text(question, style: Theme.of(context).textTheme.bodyLarge),
    );
  }
}
