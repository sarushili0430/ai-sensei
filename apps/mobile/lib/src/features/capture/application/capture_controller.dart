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
    this.reviewHoleId,
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

  /// [analysis] が復習セッションのとき、その対象の穴。
  ///
  /// **同じ穴で押し直されたときに、セッションを作り直さない**ために持つ
  /// ([startReview])。作り直すと、前回の `/start` がサーバに届いていた場合に
  /// もう1回ぶんの枠を使ってしまう。
  final String? reviewHoleId;

  final Set<String> excludedTopicIds;
  final bool isSubmitting;
  final ApiException? error;

  /// 読み取れた問題文。読めなければ null。
  SessionProblem? get problem => analysis?.problem;

  /// [problem] がこうなった理由。**読めなかったときの文言がこれで変わる。**
  ///
  /// 「読み取れませんでした」だけを出すと、生徒には直しようのない行き止まりに
  /// 見える。紙面を丸ごと撮っていたのか、解答まで写っていたのかが分かれば、
  /// 次に何をすればいいかを名指しできる。
  ProblemOutcome? get problemOutcome => analysis?.problemOutcome;

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
    String? reviewHoleId,
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
      reviewHoleId: reviewHoleId ?? this.reviewHoleId,
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
      _fail(error);
    } catch (_) {
      // 圏外・タイムアウト・プロキシのHTML応答など。ここを拾わないと
      // isSubmitting が立ったままスピナーで固まり、撮り直しの導線も消える。
      _fail(_networkError(locale));
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
      _fail(error);
      return null;
    } catch (_) {
      _fail(_networkError(locale));
      return null;
    }
  }

  /// 問題文を打ち直す(読めなかったときの救済と、誤読の訂正)。
  ///
  /// **写真は送り直さない。** 解答が混ざる・紙面を丸ごと写す、といった落ち方の
  /// 原因は「紙面のどこを写したか」なので、同じ写真を投げ直しても同じものが返る。
  /// サーバもVision LLMを回さないので、**解析の枠も今日の1回も減らない。**
  ///
  /// **失敗は戻り値で返し、[CaptureState.error] には入れない。**
  /// この画面は `state.error` を**全面のエラー表示**に使っているので、
  /// 打ち直しに失敗しただけで単元の確認ごと消えると、いま打った本文まで
  /// 画面から消える(直せる場所へ戻る道も無くなる)。
  Future<ApiException?> submitProblemText(String text, {String locale = 'ja'}) async {
    final SessionAnalysis? current = state.analysis;
    if (current == null) return null;
    final String trimmed = text.trim();
    if (trimmed.isEmpty) return null;

    try {
      final SessionAnalysis updated = await ref.read(apiClientProvider).updateSessionProblem(
            sessionId: current.sessionId,
            text: trimmed,
            locale: locale,
          );
      state = state.copyWith(analysis: updated);
      return null;
    } on ApiException catch (error) {
      // セッションごと消えているなら、握っている解析も捨てる。ここだけは
      // 全面の表示に返す — 同じIDへ打ち直し続けても、404が返り続けるだけなので。
      if (error.isSessionNotFound) _fail(error);
      return error;
    } catch (_) {
      return _networkError(locale);
    }
  }

  /// 復習(プッシュ起点)。写真は送らず、埋めにいく穴を指定する。
  ///
  /// 単元を確かめる画面が無いので、作成と開始を続けて呼ぶ。
  /// **数える位置は新規授業と同じ**(開始のほう)。
  ///
  /// **同じ穴で押し直されたら、セッションは作り直さない。** 作成は通って
  /// `/start` だけが落ちた(通信が切れた)ときに作り直すと、最初の開始が
  /// サーバに届いていた場合にもう1回ぶんの枠を使う。同じIDで始め直せば、
  /// サーバは二重に数えない。
  Future<SessionStart?> startReview(String holeId, {String locale = 'ja'}) async {
    final SessionAnalysis? pending =
        state.reviewHoleId == holeId && state.session == null ? state.analysis : null;
    state = CaptureState(isSubmitting: true, analysis: pending, reviewHoleId: holeId);

    try {
      final SessionAnalysis analysis = pending ??
          await ref.read(apiClientProvider).createSession(
                kind: 'review',
                holeId: holeId,
                locale: locale,
              );
      // **開始の前に残す。** ここで落ちても、次の一押しが同じセッションを始め直せる。
      state = state.copyWith(analysis: analysis);

      final SessionStart session = await ref.read(apiClientProvider).startSession(
            sessionId: analysis.sessionId,
            locale: locale,
          );
      state = state.copyWith(session: session, isSubmitting: false);
      return session;
    } on ApiException catch (error) {
      _fail(error);
      return null;
    } catch (_) {
      _fail(_networkError(locale));
      return null;
    }
  }

  /// 失敗を画面へ渡す。
  ///
  /// **セッションが消えていたら、握っている解析ごと捨てる。** 上限時間を過ぎた
  /// 押し直しはサーバが404にする(`entitlement.ts` の `canReissueToken`)ので、
  /// 同じIDを持ったままにすると、押し直しが同じ404を繰り返すだけになる。
  /// 捨てておけば、次の一押しは撮影(復習なら作成)からやり直せる。
  void _fail(ApiException error) {
    state = error.isSessionNotFound
        ? CaptureState(photo: state.photo, problemPhoto: state.problemPhoto, error: error)
        : state.copyWith(isSubmitting: false, error: error);
  }

  /// 圏外・タイムアウト・プロキシのHTML応答など。サーバの文言が無いので端末側で作る。
  ApiException _networkError(String locale) => ApiException(
        code: 'internal_error',
        message: AppStrings.forLanguage(locale).errorNetwork,
      );

  void reset() => state = const CaptureState();
}

