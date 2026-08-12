import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../../l10n/strings.dart';
import '../../session/domain/session.dart';
import '../../settings/application/school_stage_controller.dart';

part 'capture_controller.g.dart';

/// 撮影 → (問題の写真は任意で追加)→ 解析 → 単元と問題文の確認 → セッション開始。
///
/// 単元のチップは**外せる**。写真解析が外したときに、ユーザーが直せる余地を残す
/// (「修正可能なチップUI」)。
///
/// **写真は2枚を別々に持つ。寿命が違うから**(計画書 §4-1・`api.ts` の
/// `sessionPhotoParts`)。ノートは本人の著作物なのでR2に保存されるが、
/// 問題の紙面は他者の著作物なので解析後に破棄される。
/// **どちらの枠で送ったかでしか区別できない**ので、枠を分けて持つこと自体が
/// 破棄の前提になっている。
@immutable
class CaptureState {
  const CaptureState({
    this.photo,
    this.problemPhoto,
    this.session,
    this.excludedTopicIds = const <String>{},
    this.isSubmitting = false,
    this.error,
  });

  /// ノートの写真。**必須**(サーバが `kind: new` で要求する)。
  final File? photo;

  /// 問題(教科書・問題集の紙面)の写真。**任意**(§4-1)。
  ///
  /// 1枚に問題とノートの両方が写ることが多いので、2枚必須にすると
  /// 撮影の摩擦だけが増える。無ければ解析器はノートの写真から問題文を読み取る。
  final File? problemPhoto;

  final SessionStart? session;
  final Set<String> excludedTopicIds;
  final bool isSubmitting;
  final ApiException? error;

  /// 読み取れた問題文。読めなければ null。
  SessionProblem? get problem => session?.problem;

  List<DetectedTopic> get topics => session?.detectedTopics ?? const <DetectedTopic>[];

  List<String> get selectedTopicIds => topics
      .where((DetectedTopic it) => !excludedTopicIds.contains(it.topicId))
      .map((DetectedTopic it) => it.topicId)
      .toList(growable: false);

  bool isSelected(String topicId) => !excludedTopicIds.contains(topicId);

  /// 1つも残っていない状態では会話を始めない(許可リストが空になるため)。
  bool get canStart => selectedTopicIds.isNotEmpty && !isSubmitting;

  /// 解析に出せる状態か。**どちらか1枚あればよい。**
  ///
  /// ノートは必須ではなくなった(PM判断)。必須にしているかぎり
  /// 「手も付けられない問題」を持ってきた生徒は**紙面をノート枠に入れるしかなく**、
  /// 解析後破棄の約束が自分たちのUI制約で破られるため
  /// (`api.ts` の `sessionPhotoParts` が「既知の穴」と書いていたもの)。
  /// ノートがあるほうが良いことは変わらないので、**枠の見せ方は変えない**。
  bool get hasAnyPhoto => photo != null || problemPhoto != null;

  CaptureState copyWith({
    File? photo,
    File? problemPhoto,
    SessionStart? session,
    Set<String>? excludedTopicIds,
    bool? isSubmitting,
    ApiException? error,
    bool clearError = false,
  }) {
    return CaptureState(
      photo: photo ?? this.photo,
      problemPhoto: problemPhoto ?? this.problemPhoto,
      session: session ?? this.session,
      excludedTopicIds: excludedTopicIds ?? this.excludedTopicIds,
      isSubmitting: isSubmitting ?? this.isSubmitting,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

@Riverpod(keepAlive: true)
class CaptureController extends _$CaptureController {
  @override
  CaptureState build() => const CaptureState();

  /// ノートの写真。**問題の写真は消さない。**
  ///
  /// 以前は状態ごと作り直していたが、それだと先に問題を撮ってから
  /// ノートを撮り直したときに2枚目が黙って消える。撮影のたびに白紙に戻すのは
  /// 画面に入ったときの [reset] の役目で、ここではない。
  void setPhoto(File photo) {
    if (state.session != null) return;
    state = state.copyWith(photo: photo, clearError: true);
  }

  /// 問題の写真を足す(任意)。**解析の前にしか呼ばれない。**
  ///
  /// 解析はセッションを作る = 今日の1回を使う操作なので、あとから足して
  /// 解析し直すことはできない(`confirmAndStart` のコメントと同じ理由)。
  /// だから2枚目を足せるのは、まだ解析していないあいだだけ。
  void setProblemPhoto(File photo) {
    if (state.session != null) return;
    state = state.copyWith(problemPhoto: photo, clearError: true);
  }

  void toggleTopic(String topicId) {
    final Set<String> excluded = <String>{...state.excludedTopicIds};
    if (!excluded.remove(topicId)) excluded.add(topicId);
    state = state.copyWith(excludedTopicIds: excluded);
  }

  /// 写真を送って単元を検出する(まだ会話は始めない)。
  ///
  /// **どちらか1枚あれば出せる**([CaptureState.hasAnyPhoto])。
  /// 問題だけでも成立するのは、手も付けられない問題を持ってきた生徒に
  /// 「ノートも撮れ」と言わずに済ませるため。
  Future<void> analyze({String locale = 'ja'}) async {
    if (!state.hasAnyPhoto) return;

    state = state.copyWith(isSubmitting: true, clearError: true);
    try {
      final SessionStart session = await ref.read(apiClientProvider).createSession(
            photo: state.photo,
            problemPhoto: state.problemPhoto,
            locale: locale,
            // 単元を探す範囲を半分に切る。復習は穴が起点で写真を見ないので渡さない。
            schoolStage: ref.read(schoolStageControllerProvider).wireValue,
          );
      state = state.copyWith(
        session: session,
        isSubmitting: false,
        // 確信度の低い候補は、はじめから外しておく(押しつけない)
        excludedTopicIds: session.detectedTopics
            .where((DetectedTopic it) => !it.isConfident)
            .map((DetectedTopic it) => it.topicId)
            .toSet(),
      );
    } on ApiException catch (error) {
      state = state.copyWith(isSubmitting: false, error: error);
    } catch (_) {
      // 圏外・タイムアウト・プロキシのHTML応答など。ここを拾わないと
      // isSubmitting が立ったままスピナーで固まり、撮り直しの導線も消える。
      state = state.copyWith(
        isSubmitting: false,
        error: ApiException(
          code: 'internal_error',
          message: AppStrings.forLanguage(locale).errorNetwork,
        ),
      );
    }
  }

  /// 単元の確認を反映してからセッションを始める。
  ///
  /// チップを外しただけでは、サーバ側のセッションとLiveKitトークンは
  /// 解析時の単元のままになる。**外した単元を先輩が教えてしまう**ので、
  /// 選択が変わっていればサーバへ反映する。
  ///
  /// ここでセッションを作り直してはいけない。写真の解析時点で今日の1回は
  /// 押さえてあるので、作り直すと2回目扱いになり、会話を始める瞬間に
  /// 「今日のセッションはここまで」と返ってしまう。
  Future<SessionStart?> confirmAndStart({String locale = 'ja'}) async {
    final SessionStart? current = state.session;
    if (current == null) return null;
    if (state.excludedTopicIds.isEmpty) return current;

    state = state.copyWith(isSubmitting: true, clearError: true);
    try {
      final SessionStart session = await ref.read(apiClientProvider).updateSessionTopics(
            sessionId: current.sessionId,
            topicIds: state.selectedTopicIds,
            locale: locale,
          );
      state = state.copyWith(
        session: session,
        isSubmitting: false,
        excludedTopicIds: <String>{},
      );
      return session;
    } on ApiException catch (error) {
      state = state.copyWith(isSubmitting: false, error: error);
      return null;
    } catch (_) {
      state = state.copyWith(
        isSubmitting: false,
        error: ApiException(
          code: 'internal_error',
          message: AppStrings.forLanguage(locale).errorNetwork,
        ),
      );
      return null;
    }
  }

  /// 復習(プッシュ起点)。写真は送らず、埋めにいく穴を指定する。
  Future<SessionStart?> startReview(String holeId, {String locale = 'ja'}) async {
    state = const CaptureState(isSubmitting: true);
    try {
      final SessionStart session = await ref.read(apiClientProvider).createSession(
            kind: 'review',
            holeId: holeId,
            locale: locale,
          );
      state = state.copyWith(session: session, isSubmitting: false);
      return session;
    } on ApiException catch (error) {
      state = state.copyWith(isSubmitting: false, error: error);
      return null;
    } catch (_) {
      state = state.copyWith(
        isSubmitting: false,
        error: ApiException(
          code: 'internal_error',
          message: AppStrings.forLanguage(locale).errorNetwork,
        ),
      );
      return null;
    }
  }

  void reset() => state = const CaptureState();
}

