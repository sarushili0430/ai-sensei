import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../../l10n/strings.dart';
import '../../session/domain/session.dart';
import '../../settings/application/school_stage_controller.dart';

part 'capture_controller.g.dart';

/// 撮影 → (問題の写真は任意で追加)→ 解析 → 単元と問題文の確認 → 会話の開始。
///
/// **今日の1回を使うのは最後の一歩だけ。** 解析([analyze])まではセッションを
/// 作るだけで数えず、会話を始める([confirmAndStart] / [startReview])ときに
/// サーバが枠を押さえてトークンを返す。だから状態も2つに分かれている:
///
///   - [CaptureState.analysis] … 写真から読めたもの(単元・問題文)。数えない
///   - [CaptureState.session]  … 始まった会話(部屋の鍵)。**これが返った = 1回使った**
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
    this.analysis,
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

  /// 写真を読んだ結果。**ここまでは今日の1回を使っていない。**
  final SessionAnalysis? analysis;

  /// 始まった会話。**入った時点で今日の1回を使っている**(部屋の鍵つき)。
  final SessionStart? session;

  final Set<String> excludedTopicIds;
  final bool isSubmitting;
  final ApiException? error;

  /// 読み取れた問題文。読めなければ null。
  SessionProblem? get problem => analysis?.problem;

  List<DetectedTopic> get topics => analysis?.detectedTopics ?? const <DetectedTopic>[];

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
    SessionAnalysis? analysis,
    SessionStart? session,
    Set<String>? excludedTopicIds,
    bool? isSubmitting,
    ApiException? error,
    bool clearError = false,
  }) {
    return CaptureState(
      photo: photo ?? this.photo,
      problemPhoto: problemPhoto ?? this.problemPhoto,
      analysis: analysis ?? this.analysis,
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
    if (state.analysis != null) return;
    state = state.copyWith(photo: photo, clearError: true);
  }

  /// 問題の写真を足す(任意)。**解析の前にしか呼ばれない。**
  ///
  /// 解析はもう済んでいるので、あとから足しても読み直されない
  /// (読み直すには撮影からやり直す = この画面に入り直す)。
  void setProblemPhoto(File photo) {
    if (state.analysis != null) return;
    state = state.copyWith(problemPhoto: photo, clearError: true);
  }

  void toggleTopic(String topicId) {
    final Set<String> excluded = <String>{...state.excludedTopicIds};
    if (!excluded.remove(topicId)) excluded.add(topicId);
    state = state.copyWith(excludedTopicIds: excluded);
  }

  /// 写真を送って単元を検出する(**まだ会話は始めないので、今日の1回も使わない**)。
  ///
  /// **どちらか1枚あれば出せる**([CaptureState.hasAnyPhoto])。
  /// 問題だけでも成立するのは、手も付けられない問題を持ってきた生徒に
  /// 「ノートも撮れ」と言わずに済ませるため。
  Future<void> analyze({String locale = 'ja'}) async {
    if (!state.hasAnyPhoto) return;

    state = state.copyWith(isSubmitting: true, clearError: true);
    try {
      final SessionAnalysis analysis = await ref.read(apiClientProvider).createSession(
            photo: state.photo,
            problemPhoto: state.problemPhoto,
            locale: locale,
            // 単元を探す範囲を半分に切る。復習は穴が起点で写真を見ないので渡さない。
            schoolStage: ref.read(schoolStageControllerProvider).wireValue,
          );
      state = state.copyWith(
        analysis: analysis,
        isSubmitting: false,
        // 確信度の低い候補は、はじめから外しておく(押しつけない)
        excludedTopicIds: analysis.detectedTopics
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

  /// 単元の確認を反映してから、**会話を始める**。
  ///
  /// チップを外しただけでは、サーバ側のセッションは解析時の単元のままになる。
  /// **外した単元を先輩が教えてしまう**ので、選択が変わっていれば先に反映する。
  ///
  /// ここでセッションを作り直してはいけない。同じ写真をもう一度Vision LLMに
  /// 通すことになり、解析の回数だけを見ている上限にも二重に当たる。
  ///
  /// **今日の1回を使うのはこの最後の一歩。** 上限に当たるならここで
  /// `free_limit_reached` が返るので、撮影画面のまま文言を出せる。
  Future<SessionStart?> confirmAndStart({String locale = 'ja'}) async {
    final SessionAnalysis? current = state.analysis;
    if (current == null) return null;

    state = state.copyWith(isSubmitting: true, clearError: true);
    try {
      if (state.excludedTopicIds.isNotEmpty) {
        final SessionAnalysis narrowed = await ref.read(apiClientProvider).updateSessionTopics(
              sessionId: current.sessionId,
              topicIds: state.selectedTopicIds,
              locale: locale,
            );
        state = state.copyWith(analysis: narrowed, excludedTopicIds: <String>{});
      }

      final SessionStart session = await ref.read(apiClientProvider).startSession(
            sessionId: current.sessionId,
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

  /// 復習(プッシュ起点)。写真は送らず、埋めにいく穴を指定する。
  ///
  /// 単元を確かめる画面が無いので、作成と開始を続けて呼ぶ。
  /// **数える位置は新規授業と同じ**(開始のほう)。
  Future<SessionStart?> startReview(String holeId, {String locale = 'ja'}) async {
    state = const CaptureState(isSubmitting: true);
    try {
      final SessionAnalysis analysis = await ref.read(apiClientProvider).createSession(
            kind: 'review',
            holeId: holeId,
            locale: locale,
          );
      final SessionStart session = await ref.read(apiClientProvider).startSession(
            sessionId: analysis.sessionId,
            locale: locale,
          );
      state = state.copyWith(analysis: analysis, session: session, isSubmitting: false);
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

