import 'package:freezed_annotation/freezed_annotation.dart';

part 'karte.freezed.dart';
part 'karte.g.dart';

/// カルテのモデル。
///
/// 正は `packages/contract`(zod + JSON Schema)。Dart側はfreezedで書き、
/// `test/contract_fixture_test.dart` が同じfixtureをパースして契約ドリフトを検知する。
///
/// **点数・正答率のフィールドは持たない。** 数えるのは連続日数と埋めた穴だけ。
/// 解答・解説を入れる場所も用意しない(答えを教えないため)。

enum HoleSeverity {
  @JsonValue('low')
  low,
  @JsonValue('medium')
  medium,
  @JsonValue('high')
  high,
}

enum HoleStatus {
  @JsonValue('open')
  open,
  @JsonValue('filled')
  filled,
}

@freezed
abstract class Hole with _$Hole {
  const factory Hole({
    required String id,
    @JsonKey(name: 'topic_id') required String topicId,

    /// 「〜で説明が止まった」の形。責める文体にしない。
    @JsonKey(name: 'desc') required String description,
    required HoleSeverity severity,
    required HoleStatus status,
    @JsonKey(name: 'created_at') required DateTime createdAt,
    String? evidence,
    @JsonKey(name: 'filled_at') DateTime? filledAt,
  }) = _Hole;

  factory Hole.fromJson(Map<String, dynamic> json) => _$HoleFromJson(json);
}

@freezed
abstract class Karte with _$Karte {
  const factory Karte({
    required String id,
    @JsonKey(name: 'session_id') required String sessionId,
    @JsonKey(name: 'created_at') required DateTime createdAt,
    @JsonKey(name: 'topic_ids') required List<String> topicIds,

    /// 言えたこと。黄色のマーカーで示す。
    @JsonKey(name: 'said_well') required List<String> saidWell,

    /// 穴。ピンクのマーカーで示す。失点ではなく、これから埋まる場所。
    required List<Hole> holes,
    @JsonKey(name: 'term_notes') required List<String> termNotes,

    /// 後輩のあと追い質問(Premiumのみ)。
    @JsonKey(name: 'followup_question') String? followupQuestion,
  }) = _Karte;

  factory Karte.fromJson(Map<String, dynamic> json) => _$KarteFromJson(json);
}

@freezed
abstract class Progress with _$Progress {
  const factory Progress({
    @JsonKey(name: 'streak_days') required int streakDays,
    @JsonKey(name: 'filled_holes') required int filledHoles,
    @JsonKey(name: 'open_holes') required int openHoles,
    @JsonKey(name: 'last_session_date') String? lastSessionDate,
  }) = _Progress;

  factory Progress.fromJson(Map<String, dynamic> json) => _$ProgressFromJson(json);

  static const Progress empty = Progress(streakDays: 0, filledHoles: 0, openHoles: 0);
}

@freezed
abstract class ReviewQueueItem with _$ReviewQueueItem {
  const factory ReviewQueueItem({
    required Hole hole,
    @JsonKey(name: 'days_since') required int daysSince,

    /// 後輩の声のひとこと。通知文と同じ。
    required String prompt,
  }) = _ReviewQueueItem;

  factory ReviewQueueItem.fromJson(Map<String, dynamic> json) =>
      _$ReviewQueueItemFromJson(json);
}

@freezed
abstract class ReviewQueue with _$ReviewQueue {
  const factory ReviewQueue({
    required List<ReviewQueueItem> items,
    @JsonKey(name: 'requires_premium') required bool requiresPremium,
  }) = _ReviewQueue;

  factory ReviewQueue.fromJson(Map<String, dynamic> json) => _$ReviewQueueFromJson(json);
}
