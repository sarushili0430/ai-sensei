import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../session/domain/session.dart';

part 'capture_controller.g.dart';

/// 撮影 → 単元確認 → セッション開始。
///
/// 単元のチップは**外せる**。写真解析が外したときに、ユーザーが直せる余地を残す
/// (handoff §3-1「修正可能なチップUI」)。
@immutable
class CaptureState {
  const CaptureState({
    this.photo,
    this.session,
    this.excludedTopicIds = const <String>{},
    this.isSubmitting = false,
    this.error,
  });

  final File? photo;
  final SessionStart? session;
  final Set<String> excludedTopicIds;
  final bool isSubmitting;
  final ApiException? error;

  List<DetectedTopic> get topics => session?.detectedTopics ?? const <DetectedTopic>[];

  List<String> get selectedTopicIds => topics
      .where((DetectedTopic it) => !excludedTopicIds.contains(it.topicId))
      .map((DetectedTopic it) => it.topicId)
      .toList(growable: false);

  bool isSelected(String topicId) => !excludedTopicIds.contains(topicId);

  /// 1つも残っていない状態では会話を始めない(許可リストが空になるため)。
  bool get canStart => selectedTopicIds.isNotEmpty && !isSubmitting;

  CaptureState copyWith({
    File? photo,
    SessionStart? session,
    Set<String>? excludedTopicIds,
    bool? isSubmitting,
    ApiException? error,
    bool clearError = false,
  }) {
    return CaptureState(
      photo: photo ?? this.photo,
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

  void setPhoto(File photo) {
    state = CaptureState(photo: photo);
  }

  void toggleTopic(String topicId) {
    final Set<String> excluded = <String>{...state.excludedTopicIds};
    if (!excluded.remove(topicId)) excluded.add(topicId);
    state = state.copyWith(excludedTopicIds: excluded);
  }

  /// 写真を送って単元を検出する(まだ会話は始めない)。
  Future<void> analyze({String locale = 'ja'}) async {
    final File? photo = state.photo;
    if (photo == null) return;

    state = state.copyWith(isSubmitting: true, clearError: true);
    try {
      final SessionStart session =
          await ref.read(apiClientProvider).createSession(photo: photo, locale: locale);
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
    } catch (error, stackTrace) {
      state = state.copyWith(
        isSubmitting: false,
        error: _sendFailure('analyze', error, stackTrace),
      );
    }
  }

  /// 単元の確認を反映してからセッションを始める。
  ///
  /// チップを外しただけでは、サーバ側のセッションとLiveKitトークンは
  /// 解析時の単元のままになる。**外した単元を後輩が聞けてしまう**ので、
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
    } catch (error, stackTrace) {
      state = state.copyWith(
        isSubmitting: false,
        error: _sendFailure('confirmAndStart', error, stackTrace),
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
    } catch (error, stackTrace) {
      state = state.copyWith(
        isSubmitting: false,
        error: _sendFailure('startReview', error, stackTrace),
      );
      return null;
    }
  }

  void reset() => state = const CaptureState();
}

/// APIまで届かなかった(= サーバのJSONエラーですらない)ときの表示。
///
/// 圏外・タイムアウト・接続拒否・プロキシのHTML応答など。ここを拾わないと
/// isSubmitting が立ったままスピナーで固まり、撮り直しの導線も消える。
///
/// **握りつぶさずにログへ出す。** ユーザーに出す文言は変えられないので、
/// 黙って捨てると「うまく送れませんでした」だけが残り、
/// APIを起動し忘れたのか、URLが端末から見えていないのか
/// (エミュレータは `localhost` ではなく `10.0.2.2`)、平文HTTPが
/// OSに止められたのかが、開発者にも切り分けられなくなる。
ApiException _sendFailure(String at, Object error, StackTrace stackTrace) {
  if (kDebugMode) {
    debugPrint('[capture.$at] send failed: $error');
    debugPrintStack(stackTrace: stackTrace);
  }
  return const ApiException.unreachable();
}

