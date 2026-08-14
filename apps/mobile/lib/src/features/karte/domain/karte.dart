import 'package:freezed_annotation/freezed_annotation.dart';

part 'karte.freezed.dart';
part 'karte.g.dart';

/// Karte model.
///
/// `packages/contract` (zod + JSON Schema) is the source of truth. The Dart side
/// uses freezed, and `test/contract_fixture_test.dart` parses the same fixtures
/// to catch contract drift.
///
/// No fields for scores or accuracy: we count only streak days and filled gaps.
/// There is also no place for answers or worked solutions, since we do not give
/// the answer away.

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

/// The quiz is self-reported, not AI-graded. [notYet] is not a lost point but
/// the option that hands it back to senpai, and nobody is blamed for choosing it.
enum ReviewOutcome {
  @JsonValue('said_it')
  saidIt,
  @JsonValue('not_yet')
  notYet,
}

@freezed
abstract class Hole with _$Hole {
  const factory Hole({
    required String id,
    @JsonKey(name: 'topic_id') required String topicId,

    /// Phrased as "the explanation stopped at ...". Never accusatory.
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

    /// What they managed to say; marked in yellow.
    @JsonKey(name: 'said_well') required List<String> saidWell,

    /// Gaps, marked in pink. Not lost points, but places still to fill.
    required List<Hole> holes,
    @JsonKey(name: 'term_notes') required List<String> termNotes,

    /// Senpai's follow-up question (Premium only).
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

/// Server-enforced limits. The client only displays them; the server decides.
@freezed
abstract class SessionLimits with _$SessionLimits {
  const factory SessionLimits({
    @JsonKey(name: 'max_seconds') required int maxSeconds,

    /// Whether another lesson can start today, as of this response.
    @JsonKey(name: 'lesson_allowed_today') required bool lessonAllowedToday,
  }) = _SessionLimits;

  factory SessionLimits.fromJson(Map<String, dynamic> json) => _$SessionLimitsFromJson(json);

  static const SessionLimits unknown =
      SessionLimits(maxSeconds: 1200, lessonAllowedToday: true);
}

/// The whole `GET /v1/me/progress` response, read by home.
///
/// It carries today's lesson allowance as well as the counters, so home can say
/// "no more today" up front instead of refusing after the photo.
@freezed
abstract class ProgressSummary with _$ProgressSummary {
  const factory ProgressSummary({
    required Progress progress,
    @JsonKey(name: 'is_premium') required bool isPremium,
    required SessionLimits limits,
  }) = _ProgressSummary;

  factory ProgressSummary.fromJson(Map<String, dynamic> json) =>
      _$ProgressSummaryFromJson(json);

  static const ProgressSummary empty = ProgressSummary(
    progress: Progress.empty,
    isPremium: false,
    limits: SessionLimits.unknown,
  );
}

@freezed
abstract class ReviewQueueItem with _$ReviewQueueItem {
  const factory ReviewQueueItem({
    required Hole hole,
    @JsonKey(name: 'days_since') required int daysSince,

    /// Senpai's spoken line; the same text as the notification.
    required String prompt,

    /// The single question asked after 1/3/7 days, drawn from what they
    /// explained. Legacy fallbacks are resolved server-side, so it is always
    /// present here.
    required String quiz,
  }) = _ReviewQueueItem;

  factory ReviewQueueItem.fromJson(Map<String, dynamic> json) =>
      _$ReviewQueueItemFromJson(json);
}

/// A filled gap — the "history" the paywall advertises for Premium. It gets no
/// screen of its own; it sits in the lower half of review.
@freezed
abstract class FilledHole with _$FilledHole {
  const factory FilledHole({
    required Hole hole,
    @JsonKey(name: 'days_since_filled') required int daysSinceFilled,
  }) = _FilledHole;

  factory FilledHole.fromJson(Map<String, dynamic> json) => _$FilledHoleFromJson(json);
}

@freezed
abstract class ReviewQueue with _$ReviewQueue {
  const ReviewQueue._();

  const factory ReviewQueue({
    required List<ReviewQueueItem> items,

    /// Filled gaps, newest first. Home's counter is authoritative for the
    /// lifetime total; only recent entries appear here.
    @Default(<FilledHole>[]) List<FilledHole> filled,
  }) = _ReviewQueue;

  factory ReviewQueue.fromJson(Map<String, dynamic> json) => _$ReviewQueueFromJson(json);

  /// Nothing to show; used to pick wording that makes the emptiness clear.
  bool get isEmpty => items.isEmpty && filled.isEmpty;
}

/// Response to `POST /v1/me/reviews/{holeId}`. It updates both the gap and
/// home's counters from one response, with no extra fetch.
@freezed
abstract class ReviewAnswer with _$ReviewAnswer {
  const factory ReviewAnswer({required Hole hole, required Progress progress}) = _ReviewAnswer;

  factory ReviewAnswer.fromJson(Map<String, dynamic> json) => _$ReviewAnswerFromJson(json);
}
