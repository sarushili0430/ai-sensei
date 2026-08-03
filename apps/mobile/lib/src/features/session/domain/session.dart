import 'package:freezed_annotation/freezed_annotation.dart';

import '../../karte/domain/karte.dart';

part 'session.freezed.dart';
part 'session.g.dart';

/// セッション関連のモデル。正は `packages/contract`。

@freezed
abstract class DetectedTopic with _$DetectedTopic {
  const DetectedTopic._();

  const factory DetectedTopic({
    @JsonKey(name: 'topic_id') required String topicId,
    required String course,
    required String unit,
    required String topic,

    /// 0..1。低いものは選択済みにせず、候補として並べるだけにする。
    required double confidence,
  }) = _DetectedTopic;

  factory DetectedTopic.fromJson(Map<String, dynamic> json) => _$DetectedTopicFromJson(json);

  bool get isConfident => confidence >= 0.5;
}

@freezed
abstract class LiveKitConnection with _$LiveKitConnection {
  const factory LiveKitConnection({
    required String url,
    required String token,
    required String room,
  }) = _LiveKitConnection;

  factory LiveKitConnection.fromJson(Map<String, dynamic> json) =>
      _$LiveKitConnectionFromJson(json);
}

@freezed
abstract class SessionLimits with _$SessionLimits {
  const SessionLimits._();

  const factory SessionLimits({
    @JsonKey(name: 'max_seconds') required int maxSeconds,

    /// Premiumはnull(無制限)。
    @JsonKey(name: 'remaining_sessions_today') int? remainingSessionsToday,
  }) = _SessionLimits;

  factory SessionLimits.fromJson(Map<String, dynamic> json) => _$SessionLimitsFromJson(json);

  bool get isUnlimited => remainingSessionsToday == null;
}

@freezed
abstract class SessionStart with _$SessionStart {
  const factory SessionStart({
    @JsonKey(name: 'session_id') required String sessionId,
    required String kind,
    required LiveKitConnection livekit,
    @JsonKey(name: 'detected_topics') required List<DetectedTopic> detectedTopics,
    required SessionLimits limits,
  }) = _SessionStart;

  factory SessionStart.fromJson(Map<String, dynamic> json) => _$SessionStartFromJson(json);
}

/// セッション終了後に受け取る結果。
@freezed
abstract class SessionResult with _$SessionResult {
  const factory SessionResult({
    required Karte karte,
    required Progress progress,

    /// 初回カルテで穴が見えた直後だけ true。
    @JsonKey(name: 'show_paywall') required bool showPaywall,
  }) = _SessionResult;

  factory SessionResult.fromJson(Map<String, dynamic> json) => _$SessionResultFromJson(json);
}
