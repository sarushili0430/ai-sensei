import 'package:freezed_annotation/freezed_annotation.dart';

import '../../karte/domain/karte.dart';

part 'session.freezed.dart';
part 'session.g.dart';

/// Session models; `packages/contract` is the source of truth.

@freezed
abstract class DetectedTopic with _$DetectedTopic {
  const DetectedTopic._();

  const factory DetectedTopic({
    @JsonKey(name: 'topic_id') required String topicId,
    required String course,
    required String unit,
    required String topic,

    /// Short curriculum label for the chip, e.g. "Algebra 2".
    ///
    /// Shown exactly as the server computed it. Deriving it from the topic_id
    /// prefix on the device would make this a fourth copy of the prefix table.
    required String label,

    /// 0..1. Low values are listed as candidates rather than preselected.
    required double confidence,
  }) = _DetectedTopic;

  factory DetectedTopic.fromJson(Map<String, dynamic> json) => _$DetectedTopicFromJson(json);

  bool get isConfident => confidence >= 0.5;
}

/// Which photo the problem text was read from (`problemSources` in `api.ts`).
///
/// Not used to vary the UI: when the text is readable it is shown as is,
/// whatever the source (see [SessionProblem]). It exists because the contract
/// binds `text` and `source` in one object — so "text with no source" cannot be
/// expressed — and because this value is the only way to observe what share of
/// students send both photos.
enum ProblemSource {
  @JsonValue('problem_photo')
  problemPhoto,
  @JsonValue('notes_photo')
  notesPhoto,
}

/// The problem this session covers; present only when it could be read.
///
/// Shown before the lesson starts, because this is the earliest a misreading can
/// surface. Catching "that's a different problem" before starting is worth
/// nothing like catching it after 15 minutes of teaching.
@freezed
abstract class SessionProblem with _$SessionProblem {
  const factory SessionProblem({
    required String text,
    required ProblemSource source,
  }) = _SessionProblem;

  factory SessionProblem.fromJson(Map<String, dynamic> json) => _$SessionProblemFromJson(json);
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
  const factory SessionLimits({
    @JsonKey(name: 'max_seconds') required int maxSeconds,

    /// Whether another lesson can start today, as of this response.
    @JsonKey(name: 'lesson_allowed_today') required bool lessonAllowedToday,
  }) = _SessionLimits;

  factory SessionLimits.fromJson(Map<String, dynamic> json) => _$SessionLimitsFromJson(json);
}

/// Result of reading the photo; it carries no room key yet.
///
/// This feeds the topic and problem confirmation screen and spends nothing — the
/// use is counted when the conversation starts ([SessionStart]). The response
/// was split in two when we fixed shooting and merely viewing the topic counting
/// as the day's lesson.
@freezed
abstract class SessionAnalysis with _$SessionAnalysis {
  const factory SessionAnalysis({
    @JsonKey(name: 'session_id') required String sessionId,
    required String kind,
    @JsonKey(name: 'detected_topics') required List<DetectedTopic> detectedTopics,

    /// The problem text that was read; null if unreadable.
    ///
    /// Deliberately not `required`. The contract always sends the key
    /// (`nullable()`), but paths like a review session (`kind: review`) send no
    /// photo, so we check the value rather than the key.
    SessionProblem? problem,
  }) = _SessionAnalysis;

  factory SessionAnalysis.fromJson(Map<String, dynamic> json) => _$SessionAnalysisFromJson(json);
}

/// The started conversation. Receiving this response spends the day's use.
///
/// The room key (`livekit`) and the limits live only here by design: reserving
/// the slot and issuing the token are one server-side operation
/// (`startSessionResponseSchema` in `api.ts`). Handing out the key at analysis
/// time would make holding a key mean "can start any time", undoing the move of
/// where the use is counted.
@freezed
abstract class SessionStart with _$SessionStart {
  const factory SessionStart({
    @JsonKey(name: 'session_id') required String sessionId,
    required String kind,
    required LiveKitConnection livekit,
    required SessionLimits limits,
  }) = _SessionStart;

  factory SessionStart.fromJson(Map<String, dynamic> json) => _$SessionStartFromJson(json);
}

/// The result received after a session ends.
@freezed
abstract class SessionResult with _$SessionResult {
  const factory SessionResult({
    required Karte karte,
    required Progress progress,

    /// True only just after a gap appears in the first karte.
    @JsonKey(name: 'show_paywall') required bool showPaywall,
  }) = _SessionResult;

  factory SessionResult.fromJson(Map<String, dynamic> json) => _$SessionResultFromJson(json);
}
