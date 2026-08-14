import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../session/domain/session.dart';
import '../domain/karte.dart';

part 'karte_controllers.g.dart';

/// Progress read by home: the counters (streak days, filled gaps) and today's
/// lesson allowance. Only those two are counted — no lesson tallies or scores.
@Riverpod(keepAlive: true)
class ProgressController extends _$ProgressController {
  @override
  Future<ProgressSummary> build() =>
      ref.read(apiClientProvider).fetchProgress();

  Future<void> refresh() async {
    state = const AsyncValue<ProgressSummary>.loading();
    state = await AsyncValue.guard(
      () => ref.read(apiClientProvider).fetchProgress(),
    );
  }

  /// Carries the post-creation allowance over from the session response.
  ///
  /// Never inferred from a count: the boolean the server returned at creation is
  /// what says whether another lesson can start after this one.
  void applyLessonAllowance(bool lessonAllowedToday) {
    final ProgressSummary previous = state.value ?? ProgressSummary.empty;
    state = AsyncValue<ProgressSummary>.data(
      previous.copyWith(
        limits: previous.limits.copyWith(
          lessonAllowedToday: lessonAllowedToday,
        ),
      ),
    );
  }

  /// Right after a session, apply the progress the server returned rather than
  /// refetching. The allowance already landed via [applyLessonAllowance].
  void applyFromSession(Progress progress) {
    final ProgressSummary previous = state.value ?? ProgressSummary.empty;
    state = AsyncValue<ProgressSummary>.data(
      previous.copyWith(progress: progress),
    );
  }
}

/// Review queue, driven by push. The quiz and the 1/3/7-day revisits return
/// content even on the free tier.
@Riverpod(keepAlive: true)
class ReviewController extends _$ReviewController {
  @override
  Future<ReviewQueue> build() => ref.read(apiClientProvider).fetchReviews();

  Future<void> refresh() async {
    state = const AsyncValue<ReviewQueue>.loading();
    state = await AsyncValue.guard(
      () => ref.read(apiClientProvider).fetchReviews(),
    );
  }

  /// Sends the self-report and, on success, reloads the queue for the next
  /// question.
  Future<bool> answer(String holeId, ReviewOutcome outcome) async {
    try {
      final ReviewAnswer answer = await ref
          .read(apiClientProvider)
          .answerReview(holeId, outcome);

      // Only when "said it" fills a gap do we take the progress from the
      // response. Refetching would let the queue and home update at different
      // moments, so it is treated like the post-session case.
      if (outcome == ReviewOutcome.saidIt) {
        ref
            .read(progressControllerProvider.notifier)
            .applyFromSession(answer.progress);
      }

      await refresh();
      return state.when(
        data: (_) => true,
        error: (_, _) => false,
        loading: () => false,
      );
    } catch (error, stack) {
      debugPrint('小テストの自己申告を送れませんでした: $error\n$stack');
      return false;
    }
  }
}

/// The parts of a session result that travel across screens.
///
/// The conversation screen is AutoDispose and is already gone by the time
/// celebration and karte appear. Whether to show the paywall is the server's
/// call, so it is held independently of that screen's lifetime.
@Riverpod(keepAlive: true)
class SessionOutcomeController extends _$SessionOutcomeController {
  @override
  SessionOutcome build() => const SessionOutcome();

  void set(SessionOutcome outcome) => state = outcome;

  void clear() => state = const SessionOutcome();

  /// Fetches a karte we could not wait for.
  ///
  /// Generation takes seconds to tens of seconds after the conversation. Even
  /// after moving on to the celebration screen it is usually ready on the
  /// server; without this, a gap we just found would vanish unseen.
  Future<bool> retrieveKarte() async {
    final String? sessionId = state.sessionId;
    if (sessionId == null) return false;

    final SessionResult? result = await ref
        .read(apiClientProvider)
        .fetchSessionResult(sessionId);
    if (result == null) return false;

    ref.read(latestKarteControllerProvider.notifier).set(result.karte);
    ref
        .read(progressControllerProvider.notifier)
        .applyFromSession(result.progress);
    // The keepAlive review queue can still hold the open state from an earlier
    // read. Force a refetch before the karte screen picks an overlapping past
    // gap.
    ref.invalidate(reviewControllerProvider);
    state = SessionOutcome(
      showPaywall: result.showPaywall,
      sessionId: sessionId,
      kind: state.kind,
    );
    return true;
  }
}

@immutable
class SessionOutcome {
  const SessionOutcome({
    this.showPaywall = false,
    this.resultMissing = false,
    this.sessionId,
    this.kind,
  });

  /// True only just after a gap appears in the first karte.
  final bool showPaywall;

  /// We could not wait for karte generation to finish.
  final bool resultMissing;

  /// Session ID used to fetch the karte later.
  final String? sessionId;

  /// Session kind, held past the conversation screen so past gaps are revisited
  /// only after a lesson. Only values that passed the `SessionStart` contract
  /// land here; screens never re-infer it.
  final String? kind;

  bool get isNewLesson => kind == 'new';
}

/// The latest karte, written on session completion and read by the karte screen.
@Riverpod(keepAlive: true)
class LatestKarteController extends _$LatestKarteController {
  @override
  Karte? build() => null;

  void set(Karte karte) => state = karte;

  /// Cleared when a conversation starts: leaving the previous karte in place
  /// would show old gaps as today's if this one fails to generate.
  void clear() => state = null;
}
