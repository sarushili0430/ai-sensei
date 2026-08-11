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

/// 小テストはAIが採点せず、言えたかどうかを本人が申告する。
/// [notYet] は失点ではなく、先輩に引き取ってもらうための選択肢。
/// 選んだ人を咎めない(約束3)。
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

    /// 先輩のあと追い質問(Premiumのみ)。
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

/// サーバが強制する上限。クライアントは表示に使うだけで、判定はサーバが持つ。
@freezed
abstract class SessionLimits with _$SessionLimits {
  const factory SessionLimits({
    @JsonKey(name: 'max_seconds') required int maxSeconds,

    /// この応答時点から、今日さらに授業を始められるか。
    @JsonKey(name: 'lesson_allowed_today') required bool lessonAllowedToday,
  }) = _SessionLimits;

  factory SessionLimits.fromJson(Map<String, dynamic> json) => _$SessionLimitsFromJson(json);

  static const SessionLimits unknown =
      SessionLimits(maxSeconds: 1200, lessonAllowedToday: true);
}

/// `GET /v1/me/progress` の全体。ホームが読む。
///
/// カウンターだけでなく今日の授業可否も返ってきているので、
/// 「今日はもう撮れない」をホームで先に伝えられる(撮ってから断らない)。
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

    /// 先輩の声のひとこと。通知文と同じ。
    required String prompt,

    /// 1/3/7日後にたずねる**1問**。出題元は本人が説明した内容(§2)。
    /// 旧データのフォールバックはサーバ側で解決済みなので、ここでは必ず入っている。
    required String quiz,
  }) = _ReviewQueueItem;

  factory ReviewQueueItem.fromJson(Map<String, dynamic> json) =>
      _$ReviewQueueItemFromJson(json);
}

/// 埋まった穴。ペイウォールが謳う Premium の「履歴」はこれ。
/// 別画面は作らず、復習画面の下半分に置く。
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

    /// 埋めた穴(新しい順)。通算の件数はホームのカウンターのほうが正で、
    /// ここには直近ぶんしか載らない。
    @Default(<FilledHole>[]) List<FilledHole> filled,
  }) = _ReviewQueue;

  factory ReviewQueue.fromJson(Map<String, dynamic> json) => _$ReviewQueueFromJson(json);

  /// 見せるものが何もない状態。空だと分かる文言を出すために使う。
  bool get isEmpty => items.isEmpty && filled.isEmpty;
}

/// `POST /v1/me/reviews/{holeId}` の応答。
/// 穴とホームのカウンターを、追加の取得なしで同じ応答から更新する。
@freezed
abstract class ReviewAnswer with _$ReviewAnswer {
  const factory ReviewAnswer({required Hole hole, required Progress progress}) = _ReviewAnswer;

  factory ReviewAnswer.fromJson(Map<String, dynamic> json) => _$ReviewAnswerFromJson(json);
}
