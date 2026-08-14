import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/api_client.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../../session/domain/session.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// Review screen, reached from home's card or a push notification.
///
/// It shows two things: gaps to fill (what is next) and filled gaps (what has
/// been done). The latter is the "history" the paywall advertises, and gets no
/// screen of its own.
///
/// Every state has an exit. People can land here straight from a notification,
/// so a dead end of "still loading" or bare copy would really trap them.
class ReviewScreen extends ConsumerStatefulWidget {
  const ReviewScreen({super.key});

  @override
  ConsumerState<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends ConsumerState<ReviewScreen> {
  /// The gap answered "not yet". The ID changes as the queue advances, so it
  /// returns to the question state on its own.
  String? _notYetHoleId;
  bool _isAnswering = false;
  bool _answerFailed = false;
  bool _showLessonError = false;

  Future<void> _answer(ReviewQueueItem item) async {
    setState(() {
      _isAnswering = true;
      _answerFailed = false;
    });

    final bool succeeded = await ref
        .read(reviewControllerProvider.notifier)
        .answer(item.hole.id, ReviewOutcome.saidIt);
    if (!mounted) return;

    setState(() {
      _isAnswering = false;
      _answerFailed = !succeeded;
      if (succeeded) _notYetHoleId = null;
    });
  }

  void _chooseNotYet(ReviewQueueItem item) {
    // "Not yet" alone sends nothing: the gap stays open and they choose what to
    // do next.
    setState(() {
      _notYetHoleId = item.hole.id;
      _answerFailed = false;
      _showLessonError = false;
    });
  }

  void _later() {
    setState(() {
      _notYetHoleId = null;
      _showLessonError = false;
    });
  }

  void _openPaywall() {
    setState(() => _showLessonError = false);
    context.push(AppRoute.paywall.path);
  }

  Future<void> _startLesson(ReviewQueueItem item) async {
    setState(() => _showLessonError = false);

    // Review lessons use no photo; the server builds a session from this gap.
    final SessionStart? session = await ref
        .read(captureControllerProvider.notifier)
        .startReview(
          item.hole.id,
          locale: Localizations.localeOf(context).languageCode,
        );
    if (!mounted) return;

    // The conversation is one-way; give it no back target.
    if (session != null) {
      context.go(AppRoute.session.path);
    } else {
      // startReview records the failure reason in CaptureState; never leave
      // them on the old screen with no explanation.
      setState(() => _showLessonError = true);
    }
  }

  Widget _content({
    required AppStrings strings,
    required ReviewQueue data,
    required ProgressSummary progress,
    required CaptureState capture,
  }) {
    // One question at a time: no list of the rest, just the first, shown large.
    final ReviewQueueItem? item = data.items.isEmpty ? null : data.items.first;
    final bool notYet = item != null && _notYetHoleId == item.hole.id;
    final ApiException? lessonError = notYet && _showLessonError
        ? capture.error
        : null;
    final bool premiumRequired =
        !progress.isPremium || lessonError?.isPremiumRequired == true;
    final bool lessonLimitReached =
        lessonError != null &&
        (lessonError.isFreeLimitReached || lessonError.isFairUseLimitReached);
    final bool lessonAllowedToday =
        !premiumRequired &&
        progress.limits.lessonAllowedToday &&
        !lessonLimitReached;
    // When an error code arrives in a race, the server's verdict beats the
    // progress we last read.
    final bool showUpgrade = lessonError?.isFairUseLimitReached == true
        ? false
        : premiumRequired || lessonError?.isFreeLimitReached == true;

    String? errorMessage;
    if (!notYet && _answerFailed) {
      errorMessage = strings.errorGeneric;
    } else if (notYet &&
        _showLessonError &&
        !lessonLimitReached &&
        !premiumRequired) {
      // Apart from the daily limit, show the server's reason verbatim, as
      // capture does.
      final String message = lessonError?.message ?? strings.errorGeneric;
      errorMessage = message.isEmpty ? strings.errorGeneric : message;
    }

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: <Widget>[
        if (item != null) ...<Widget>[
          _ReviewCard(
            item: item,
            notYet: notYet,
            isBusy: _isAnswering || (notYet && capture.isSubmitting),
            lessonAllowedToday: lessonAllowedToday,
            showUpgrade: showUpgrade,
            errorMessage: errorMessage,
            onSaidIt: () => _answer(item),
            onNotYet: () => _chooseNotYet(item),
            // Voice review lessons are Premium; called only when both the
            // subscription and the daily allowance pass.
            onAskSenpai: () => _startLesson(item),
            onUpgrade: _openPaywall,
            onLater: _later,
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        if (item == null)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: Text(
              strings.reviewEmpty,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
        const SizedBox(height: AppSpacing.lg),
        _FilledSection(filled: data.filled),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ReviewQueue> queue = ref.watch(reviewControllerProvider);
    final AsyncValue<ProgressSummary> progress = ref.watch(
      progressControllerProvider,
    );
    final CaptureState capture = ref.watch(captureControllerProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.reviewTitle),
        // Arriving straight from a notification leaves nothing to pop to, so
        // fall back to home.
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: context.closeOrGoHome,
        ),
      ),
      body: SafeArea(
        child: queue.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (Object error, StackTrace stack) => _Message(
            text: strings.errorGeneric,
            primaryLabel: strings.errorRetry,
            onPrimary: () =>
                ref.read(reviewControllerProvider.notifier).refresh(),
          ),
          data: (ReviewQueue data) {
            if (data.isEmpty) {
              return _Message(text: strings.reviewEmpty);
            }
            // Never hold the quiz hostage to a progress fetch.
            //
            // The quiz is sold as one question, text, ten seconds, and only the
            // queue is needed to answer it. Progress is used solely for the
            // Premium check on "ask senpai" and for `lessonAllowedToday`, so
            // said it / not yet must stay answerable without it.
            //
            // While it is missing, fail towards "no allowance": answering now
            // beats advancing into a lesson only to be refused, which costs the
            // most trust.
            return _content(
              strings: strings,
              data: data,
              progress: progress.value ?? ProgressSummary.empty,
              capture: capture,
            );
          },
        ),
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({
    required this.item,
    required this.notYet,
    required this.isBusy,
    required this.lessonAllowedToday,
    required this.showUpgrade,
    required this.onSaidIt,
    required this.onNotYet,
    required this.onAskSenpai,
    required this.onUpgrade,
    required this.onLater,
    this.errorMessage,
  });

  final ReviewQueueItem item;
  final bool notYet;
  final bool isBusy;
  final bool lessonAllowedToday;
  final bool showUpgrade;
  final VoidCallback onSaidIt;
  final VoidCallback onNotYet;
  final VoidCallback onAskSenpai;
  final VoidCallback onUpgrade;
  final VoidCallback onLater;
  final String? errorMessage;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
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
          if (notYet) ...<Widget>[
            // "Not yet" draws no blame; senpai takes it from here.
            Text(
              strings.reviewNotYetLead,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: AppSpacing.md),
            if (lessonAllowedToday) ...<Widget>[
              if (errorMessage != null) ...<Widget>[
                Text(
                  errorMessage!,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: AppSpacing.md),
              ],
              ChunkyButton(
                label: strings.reviewAskSenpai,
                onPressed: isBusy ? null : onAskSenpai,
              ),
            ] else ...<Widget>[
              if (showUpgrade) ...<Widget>[
                // The quiz stays open: only voice lessons, where metered cost
                // starts, sit behind the boundary.
                Text(
                  strings.reviewVoicePremium,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                TextButton(
                  onPressed: onUpgrade,
                  style: TextButton.styleFrom(
                    foregroundColor: AppColors.blue,
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.sm,
                    ),
                  ),
                  child: Text(
                    strings.homeUnlock,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ] else
                // The Premium fair-use limit is framed as senpai closing out
                // today's study.
                Text(
                  strings.lessonEnoughForToday,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
            const SizedBox(height: AppSpacing.sm),
            GhostButton(
              label: strings.reviewLater,
              onPressed: isBusy ? null : onLater,
            ),
          ] else ...<Widget>[
            // Senpai's spoken line, identical to the notification text so it
            // reads as a continuation.
            Text(item.prompt, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.md),
            Text(item.quiz, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.lg),
            if (errorMessage != null) ...<Widget>[
              Text(errorMessage!, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: AppSpacing.md),
            ],
            ChunkyButton(
              label: strings.reviewSaidIt,
              onPressed: isBusy ? null : onSaidIt,
            ),
            const SizedBox(height: AppSpacing.sm),
            // "Not yet" costs nothing to choose; the promise, as a GhostButton.
            GhostButton(
              label: strings.reviewNotYet,
              onPressed: isBusy ? null : onNotYet,
            ),
          ],
        ],
      ),
    );
  }
}

/// Filled gaps — the "history" the paywall advertises for Premium.
///
/// Presented quietly; none of the celebration screen's noise.
class _FilledSection extends StatelessWidget {
  const _FilledSection({required this.filled});

  final List<FilledHole> filled;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          strings.reviewFilledTitle(filled.length),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.sm),
        if (filled.isEmpty)
          Text(
            strings.reviewFilledEmpty,
            style: Theme.of(context).textTheme.bodySmall,
          )
        else
          // Filled gaps are redrawn in yellow, not pink. Drawing them top down
          // makes them read as something accumulated.
          for (int i = 0; i < filled.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  MarkerText(
                    filled[i].hole.description,
                    marker: MarkerColor.said,
                    delay: AppDurations.draw * i,
                  ),
                  Text(
                    strings.reviewFilledDays(filled[i].daysSinceFilled),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
      ],
    );
  }
}

/// Screen for when there is nothing to show; always offers a way home.
class _Message extends StatelessWidget {
  const _Message({required this.text, this.primaryLabel, this.onPrimary});

  final String text;
  final String? primaryLabel;
  final VoidCallback? onPrimary;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String? label = primaryLabel;

    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(
            text,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: AppSpacing.lg),
          if (label != null && onPrimary != null)
            ChunkyButton(label: label, onPressed: onPrimary),
          GhostButton(
            label: strings.reviewBackHome,
            onPressed: context.closeOrGoHome,
          ),
        ],
      ),
    );
  }
}
