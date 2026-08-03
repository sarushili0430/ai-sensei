import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../api/api_client.dart';
import '../../session/domain/session.dart';

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

class CaptureController extends Notifier<CaptureState> {
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
    }
  }

  void reset() => state = const CaptureState();
}

final NotifierProvider<CaptureController, CaptureState> captureControllerProvider =
    NotifierProvider<CaptureController, CaptureState>(CaptureController.new);
