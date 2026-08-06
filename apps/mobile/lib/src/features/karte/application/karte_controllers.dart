import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../session/domain/session.dart';
import '../domain/karte.dart';

part 'karte_controllers.g.dart';

/// ホーム画面が読む進捗。カウンター(連続日数・埋めた穴)と、
/// 今日あと何回撮れるか。数えるのはこの2つだけで、点数は持たない。
@Riverpod(keepAlive: true)
class ProgressController extends _$ProgressController {
  @override
  Future<ProgressSummary> build() => ref.read(apiClientProvider).fetchProgress();

  Future<void> refresh() async {
    state = const AsyncValue<ProgressSummary>.loading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchProgress());
  }

  /// セッション直後は、サーバが返した進捗をそのまま反映する(再取得しない)。
  ///
  /// `/complete` のレスポンスに残セッション数は入っていないので、
  /// 1回ぶん自分で減らす。ホームに戻った瞬間に古い数字が残らないようにするため
  /// で、判定そのものはサーバが持っている(ここがずれても撮れる/撮れないは変わらない)。
  void applyFromSession(Progress progress) {
    final ProgressSummary previous = state.value ?? ProgressSummary.empty;
    final int? remaining = previous.limits.remainingSessionsToday;
    state = AsyncValue<ProgressSummary>.data(
      previous.copyWith(
        progress: progress,
        limits: previous.limits.copyWith(
          remainingSessionsToday: remaining == null ? null : (remaining - 1).clamp(0, remaining),
        ),
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
    state = SessionOutcome(showPaywall: result.showPaywall, sessionId: sessionId);
    return true;
  }
}

@immutable
class SessionOutcome {
  const SessionOutcome({
    this.showPaywall = false,
    this.resultMissing = false,
    this.sessionId,
  });

  /// 初回カルテで穴が見えた直後だけ true。
  final bool showPaywall;

  /// カルテの生成を待ちきれなかった。
  final bool resultMissing;

  /// あとからカルテを取りに行くためのセッションID。
  final String? sessionId;
}

/// 直近のカルテ。セッション完了時に置かれ、カルテ画面が読む。
@Riverpod(keepAlive: true)
class LatestKarteController extends _$LatestKarteController {
  @override
  Karte? build() => null;

  void set(Karte karte) => state = karte;
}
