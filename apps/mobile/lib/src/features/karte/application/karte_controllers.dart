import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../session/domain/session.dart';
import '../domain/karte.dart';

part 'karte_controllers.g.dart';

/// ホーム画面が読む進捗。カウンター(連続日数・埋めた穴)と、今日の授業可否。
/// 数えるのは連続日数と埋めた穴だけで、授業回数や点数は持たない。
@Riverpod(keepAlive: true)
class ProgressController extends _$ProgressController {
  @override
  Future<ProgressSummary> build() => ref.read(apiClientProvider).fetchProgress();

  Future<void> refresh() async {
    state = const AsyncValue<ProgressSummary>.loading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchProgress());
  }

  /// セッション作成後の可否を、そのレスポンスから引き継ぐ。
  ///
  /// 回数から推測しない。セッションを作った時点でサーバが返した真偽値が、
  /// その授業のあとにもう一度始められるかを表している。
  void applyLessonAllowance(bool lessonAllowedToday) {
    final ProgressSummary previous = state.value ?? ProgressSummary.empty;
    state = AsyncValue<ProgressSummary>.data(
      previous.copyWith(
        limits: previous.limits.copyWith(lessonAllowedToday: lessonAllowedToday),
      ),
    );
  }

  /// セッション直後は、サーバが返した進捗をそのまま反映する(再取得しない)。
  /// 授業可否はセッション作成時に [applyLessonAllowance] で反映済み。
  void applyFromSession(Progress progress) {
    final ProgressSummary previous = state.value ?? ProgressSummary.empty;
    state = AsyncValue<ProgressSummary>.data(
      previous.copyWith(
        progress: progress,
      ),
    );
  }
}

/// 復習キュー(プッシュ起点)。無料ユーザーには空で返る。
@Riverpod(keepAlive: true)
class ReviewController extends _$ReviewController {
  @override
  Future<ReviewQueue> build() => ref.read(apiClientProvider).fetchReviews();

  Future<void> refresh() async {
    state = const AsyncValue<ReviewQueue>.loading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchReviews());
  }

  /// 「言えるようになった」という本人の申告を反映する。
  ///
  /// APIの成功を受けて手元の配列だけを移し替えない。サーバでは同時に
  /// 1/3/7日の通知も取り消しているので、成功後に復習キューと進捗を読み直し、
  /// **サーバが完了した状態**を画面の正にする。再送はAPI側が冪等に受ける。
  Future<void> fillHole(String holeId) async {
    await ref.read(apiClientProvider).fillHole(holeId);
    await Future.wait<void>(<Future<void>>[
      refresh(),
      ref.read(progressControllerProvider.notifier).refresh(),
    ]);
  }
}

/// セッションの結果のうち、画面をまたいで持ち回るもの。
///
/// 会話画面は AutoDispose なので、祝福・カルテ画面に着いたときには
/// もう破棄されている。ペイウォールを出すかどうかは**サーバの判断**なので、
/// 会話画面の寿命と切り離して保持する。
@Riverpod(keepAlive: true)
class SessionOutcomeController extends _$SessionOutcomeController {
  @override
  SessionOutcome build() => const SessionOutcome();

  void set(SessionOutcome outcome) => state = outcome;

  void clear() => state = const SessionOutcome();

  /// 待ちきれなかったカルテを、あとから取りに行く。
  ///
  /// カルテ生成は会話のあとに数秒〜十数秒かかる。待ち切れずに祝福画面へ
  /// 進んだあとも、**サーバにはできている**ことが多い。ここが無いと、
  /// せっかく見つけた穴が二度と見られないまま消える。
  Future<bool> retrieveKarte() async {
    final String? sessionId = state.sessionId;
    if (sessionId == null) return false;

    final SessionResult? result =
        await ref.read(apiClientProvider).fetchSessionResult(sessionId);
    if (result == null) return false;

    ref.read(latestKarteControllerProvider.notifier).set(result.karte);
    ref.read(progressControllerProvider.notifier).applyFromSession(result.progress);
    // keepAliveの復習キューには、前回読んだopen状態が残りうる。カルテ画面で
    // 「今回と重なる過去の穴」を選ぶ前に、完了後の状態を取り直させる。
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

  /// 初回カルテで穴が見えた直後だけ true。
  final bool showPaywall;

  /// カルテの生成を待ちきれなかった。
  final bool resultMissing;

  /// あとからカルテを取りに行くためのセッションID。
  final String? sessionId;

  /// 授業後だけ過去の穴を聞き直すために、会話画面の寿命を越えて持つ種類。
  /// `SessionStart` の契約を通った値だけが入り、画面側で推測し直さない。
  final String? kind;

  bool get isNewLesson => kind == 'new';
}

/// 直近のカルテ。セッション完了時に置かれ、カルテ画面が読む。
@Riverpod(keepAlive: true)
class LatestKarteController extends _$LatestKarteController {
  @override
  Karte? build() => null;

  void set(Karte karte) => state = karte;

  /// 会話を始めるときに空にする。前回のカルテを残したまま今回のカルテが
  /// 作れないと、古い穴が「今日のカルテ」として出てしまう。
  void clear() => state = null;
}
