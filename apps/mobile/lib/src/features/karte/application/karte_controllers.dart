import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../domain/karte.dart';

part 'karte_controllers.g.dart';

/// `features/karte/` は旧カルテ中心の名だが、移動すると広い import 差分になるため
/// この issue では名前を残し、復習問題への置き換えだけを行う。
///
/// ホーム画面が読む進捗。学習成果として数えるのは連続日数と解けた問題で、
/// 授業回数や点数は持たない。
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

  /// いま見えている進捗を残したまま、サーバの正しい値へ差し替える。
  ///
  /// `/v1/me/progress` は残高だけを読むには重いが、セッション終了・ホーム復帰の
  /// 各境界で1回ずつ読むだけ。そのために専用APIを増やすと契約・実装・テストが
  /// 二重になるので、既存の経路を使い、通信中も前の表示を残す。
  Future<void> reloadQuietly() async {
    try {
      final ProgressSummary progress = await ref.read(apiClientProvider).fetchProgress();
      if (!ref.mounted) return;
      state = AsyncValue<ProgressSummary>.data(progress);
    } on Object catch (error, stack) {
      // ホームの体裁を整えるための再確認なので、取得失敗で前の数字まで消すと
      // 一時的な通信不良のたびに残り時間の行そのものがちらつく。
      debugPrint('進捗を静かに取り直せませんでした(前の表示を残します): $error\n$stack');
    }
  }

  /// `/start` の仮押さえ後の残高と可否を、サーバの応答からそのまま引き継ぐ。
  /// 応答が無いときやホーム復帰時にサーバを正として取り直す場合は [reloadQuietly] を使う。
  void applySessionLimits({
    required int maxSeconds,
    required int remainingSecondsToday,
    required bool lessonAllowedToday,
  }) {
    final ProgressSummary previous = state.value ?? ProgressSummary.empty;
    state = AsyncValue<ProgressSummary>.data(
      previous.copyWith(
        limits: previous.limits.copyWith(
          maxSeconds: maxSeconds,
          remainingSecondsToday: remainingSecondsToday,
          lessonAllowedToday: lessonAllowedToday,
        ),
      ),
    );
  }

  /// セッション直後は、サーバが返した進捗をそのまま反映する(再取得しない)。
  /// 授業可否はセッション開始時に [applySessionLimits] で反映済み。
  /// 結果そのものが届かなかった場合は、この引き継ぎではなく [reloadQuietly] を使う。
  void applyFromSession(Progress progress) {
    final ProgressSummary previous = state.value ?? ProgressSummary.empty;
    state = AsyncValue<ProgressSummary>.data(
      previous.copyWith(progress: progress),
    );
  }
}

/// 復習キュー(プッシュ起点)。問題と採点つき解答は無料でも中身を返す。
@Riverpod(keepAlive: true)
class ReviewController extends _$ReviewController {
  @override
  Future<PracticeQueue> build() => ref.read(apiClientProvider).fetchPractice();

  Future<void> refresh() async {
    state = const AsyncValue<PracticeQueue>.loading();
    state = await AsyncValue.guard(
      () => ref.read(apiClientProvider).fetchPractice(),
    );
  }
}

/// 通知が名指しした1問。**リストに無い問題でも開けるようにする。**
///
/// 正解した問題にも7日後の通知は届く(作成時に決めた段は取り消さない。ADR 0009)。
/// その問題は `items` から `solved` へ回っていて、`solved` にも直近ぶんしか
/// 載らないので、**よく解く生徒ほど自分の通知を開けなくなる**。
/// 通知の宛先の解決だけは、リストではなく1問ぶんのAPIで行う。
@riverpod
Future<PracticeQueueItem> practiceProblem(Ref ref, String problemId) =>
    ref.read(apiClientProvider).fetchPracticeProblem(problemId);

/// 画面を離れても残す、問題ごとの解答・採点状態。
///
/// 採点中に route が破棄されても TextEditingController の寿命へ解答を預けない。
/// そうしないと通知を閉じて戻っただけで、本人が書いた式が消えてしまう。
@immutable
class PracticeAnswersState {
  const PracticeAnswersState({
    this.drafts = const <String, String>{},
    this.grading = const <String>{},
    this.answers = const <String, PracticeAnswer>{},
    this.errors = const <String, Object>{},
  });

  final Map<String, String> drafts;
  final Set<String> grading;
  final Map<String, PracticeAnswer> answers;
  final Map<String, Object> errors;

  String draftFor(String problemId) => drafts[problemId] ?? '';
  bool isGrading(String problemId) => grading.contains(problemId);
  PracticeAnswer? answerFor(String problemId) => answers[problemId];
  Object? errorFor(String problemId) => errors[problemId];
}

@Riverpod(keepAlive: true)
class PracticeAnswerController extends _$PracticeAnswerController {
  @override
  PracticeAnswersState build() => const PracticeAnswersState();

  void updateDraft(String problemId, String response) {
    state = PracticeAnswersState(
      drafts: <String, String>{...state.drafts, problemId: response},
      grading: state.grading,
      answers: state.answers,
      errors: <String, Object>{...state.errors}..remove(problemId),
    );
  }

  Future<bool> submit(String problemId) async {
    final String response = state.draftFor(problemId).trim();
    if (response.isEmpty || state.isGrading(problemId)) return false;

    state = PracticeAnswersState(
      drafts: state.drafts,
      grading: <String>{...state.grading, problemId},
      answers: state.answers,
      errors: <String, Object>{...state.errors}..remove(problemId),
    );

    try {
      final PracticeAnswer answer = await ref
          .read(apiClientProvider)
          .answerPractice(problemId, response);
      ref
          .read(progressControllerProvider.notifier)
          .applyFromSession(answer.progress);
      state = PracticeAnswersState(
        drafts: <String, String>{
          ...state.drafts,
          problemId: answer.attempt.response,
        },
        grading: <String>{...state.grading}..remove(problemId),
        answers: <String, PracticeAnswer>{...state.answers, problemId: answer},
        errors: <String, Object>{...state.errors}..remove(problemId),
      );
      return true;
    } on Object catch (error, stack) {
      debugPrint('復習問題を採点できませんでした: $error\n$stack');
      state = PracticeAnswersState(
        drafts: state.drafts,
        grading: <String>{...state.grading}..remove(problemId),
        answers: state.answers,
        errors: <String, Object>{...state.errors, problemId: error},
      );
      return false;
    }
  }

  /// `unclear` は間違いではないので、同じ文を残したまま編集へ戻す。
  void retry(String problemId) {
    state = PracticeAnswersState(
      drafts: state.drafts,
      grading: <String>{...state.grading}..remove(problemId),
      answers: <String, PracticeAnswer>{...state.answers}..remove(problemId),
      errors: <String, Object>{...state.errors}..remove(problemId),
    );
  }

  void clear(String problemId) {
    state = PracticeAnswersState(
      drafts: <String, String>{...state.drafts}..remove(problemId),
      grading: <String>{...state.grading}..remove(problemId),
      answers: <String, PracticeAnswer>{...state.answers}..remove(problemId),
      errors: <String, Object>{...state.errors}..remove(problemId),
    );
  }
}

/// セッションの結果のうち、画面をまたいで持ち回るもの。
///
/// 会話画面は AutoDispose なので、祝福画面に着いたときにはもう破棄されている。
/// 「わかった」と時間切れを見た目で分けるため、終了理由を画面の寿命と切り離す。
@Riverpod(keepAlive: true)
class SessionOutcomeController extends _$SessionOutcomeController {
  @override
  SessionOutcome build() => const SessionOutcome();

  void set(SessionOutcome outcome) => state = outcome;

  void clear() => state = const SessionOutcome();
}

enum SessionEnding { understood, timeLimit, other }

@immutable
class SessionOutcome {
  const SessionOutcome({
    this.showPaywall = false,
    this.kind,
    this.ending = SessionEnding.understood,
  });

  /// **無料で今日の1回を使い切った回だけ** true(サーバの `show_paywall`)。
  /// 祝福画面はこれでペイウォールを開き、「もう1問」の出口を差し替える。
  final bool showPaywall;

  /// 復習セッションかどうかを、会話画面の寿命を越えて持つ種類。
  /// `SessionStart` の契約を通った値だけが入り、画面側で推測し直さない。
  final String? kind;

  final SessionEnding ending;

  bool get isNewLesson => kind == 'new';
}
