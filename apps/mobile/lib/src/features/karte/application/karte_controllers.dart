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

/// 直近のカルテ。セッション完了時に置かれ、カルテ画面が読む。
final NotifierProvider<LatestKarteController, Karte?> latestKarteProvider =
    NotifierProvider<LatestKarteController, Karte?>(LatestKarteController.new);

class LatestKarteController extends Notifier<Karte?> {
  @override
  Karte? build() => null;

  void set(Karte karte) => state = karte;
}
