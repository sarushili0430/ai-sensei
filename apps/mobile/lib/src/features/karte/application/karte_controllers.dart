import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../api/api_client.dart';
import '../domain/karte.dart';

/// ホーム画面のカウンター。連続日数と埋めた穴だけを持つ。
class ProgressController extends AsyncNotifier<Progress> {
  @override
  Future<Progress> build() => ref.read(apiClientProvider).fetchProgress();

  Future<void> refresh() async {
    state = const AsyncValue<Progress>.loading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchProgress());
  }

  /// セッション直後は、サーバが返した進捗をそのまま反映する(再取得しない)。
  void applyFromSession(Progress progress) {
    state = AsyncValue<Progress>.data(progress);
  }
}

final AsyncNotifierProvider<ProgressController, Progress> progressControllerProvider =
    AsyncNotifierProvider<ProgressController, Progress>(ProgressController.new);

/// 復習キュー(プッシュ起点)。無料ユーザーには空で返る。
class ReviewController extends AsyncNotifier<ReviewQueue> {
  @override
  Future<ReviewQueue> build() => ref.read(apiClientProvider).fetchReviews();

  Future<void> refresh() async {
    state = const AsyncValue<ReviewQueue>.loading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchReviews());
  }
}

final AsyncNotifierProvider<ReviewController, ReviewQueue> reviewControllerProvider =
    AsyncNotifierProvider<ReviewController, ReviewQueue>(ReviewController.new);

/// セッションの結果のうち、画面をまたいで持ち回るもの。
///
/// 会話画面は AutoDispose なので、祝福・カルテ画面に着いたときには
/// もう破棄されている。ペイウォールを出すかどうかは**サーバの判断**なので、
/// 会話画面の寿命と切り離して保持する。
class SessionOutcomeController extends Notifier<SessionOutcome> {
  @override
  SessionOutcome build() => const SessionOutcome();

  void set(SessionOutcome outcome) => state = outcome;

  void clear() => state = const SessionOutcome();
}

@immutable
class SessionOutcome {
  const SessionOutcome({this.showPaywall = false, this.resultMissing = false});

  /// 初回カルテで穴が見えた直後だけ true。
  final bool showPaywall;

  /// カルテの生成を待ちきれなかった。
  final bool resultMissing;
}

final NotifierProvider<SessionOutcomeController, SessionOutcome> sessionOutcomeProvider =
    NotifierProvider<SessionOutcomeController, SessionOutcome>(SessionOutcomeController.new);

/// 直近のカルテ。セッション完了時に置かれ、カルテ画面が読む。
final NotifierProvider<LatestKarteController, Karte?> latestKarteProvider =
    NotifierProvider<LatestKarteController, Karte?>(LatestKarteController.new);

class LatestKarteController extends Notifier<Karte?> {
  @override
  Karte? build() => null;

  void set(Karte karte) => state = karte;
}
