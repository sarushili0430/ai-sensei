import 'package:freezed_annotation/freezed_annotation.dart';

part 'karte.freezed.dart';
part 'karte.g.dart';

/// カルテのモデル。
///
/// 正は `packages/contract`(zod + JSON Schema)。Dart側はfreezedで書き、
/// `test/contract_fixture_test.dart` が同じfixtureをパースして契約ドリフトを検知する。
///
/// **点数・正答率のフィールドは持たない。** 数えるのは連続日数と解けた問題だけ。
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

    /// 旧カルテ由来の値。移行前の記録を読めるよう残すが、画面の数字には使わない。
    /// [solvedProblems] と足すと、同じ学習を別単位で二重計上してしまう。
    @JsonKey(name: 'filled_holes') required int filledHoles,

    /// 旧カルテ由来の値。復習問題の残数には [openProblems] だけを使う。
    @JsonKey(name: 'open_holes') required int openHoles,
    @JsonKey(name: 'solved_problems') required int solvedProblems,
    @JsonKey(name: 'open_problems') required int openProblems,
    @JsonKey(name: 'last_session_date') String? lastSessionDate,
  }) = _Progress;

  factory Progress.fromJson(Map<String, dynamic> json) => _$ProgressFromJson(json);

  static const Progress empty = Progress(
    streakDays: 0,
    filledHoles: 0,
    openHoles: 0,
    solvedProblems: 0,
    openProblems: 0,
  );
}

/// サーバが強制する上限。クライアントは表示に使うだけで、判定はサーバが持つ。
@freezed
abstract class SessionLimits with _$SessionLimits {
  const factory SessionLimits({
    @JsonKey(name: 'max_seconds') required int maxSeconds,
    @JsonKey(name: 'remaining_seconds_today') required int remainingSecondsToday,

    /// この応答時点から、今日さらに授業を始められるか。
    @JsonKey(name: 'lesson_allowed_today') required bool lessonAllowedToday,
  }) = _SessionLimits;

  factory SessionLimits.fromJson(Map<String, dynamic> json) => _$SessionLimitsFromJson(json);

  static const SessionLimits unknown =
      SessionLimits(maxSeconds: 1200, remainingSecondsToday: 0, lessonAllowedToday: true);
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

/// 復習問題の採点結果。`unclear` は不正解ではなく、採点側が読めなかった状態。
enum PracticeVerdict {
  @JsonValue('correct')
  correct,
  @JsonValue('incorrect')
  incorrect,
  @JsonValue('unclear')
  unclear,
}

/// 生徒へ返す復習問題。正解は採点サーバだけが持ち、ここには入らない。
@freezed
abstract class PracticeProblem with _$PracticeProblem {
  const factory PracticeProblem({
    required String id,
    @JsonKey(name: 'session_id') required String sessionId,
    @JsonKey(name: 'board_id') required String boardId,
    @JsonKey(name: 'topic_id') required String topicId,
    required String question,
    @JsonKey(name: 'created_at') required DateTime createdAt,
  }) = _PracticeProblem;

  factory PracticeProblem.fromJson(Map<String, dynamic> json) =>
      _$PracticeProblemFromJson(json);
}

/// 1回ぶんの本人の解答とAI採点。結果画面はこの値だけを正として描く。
@freezed
abstract class PracticeAttempt with _$PracticeAttempt {
  const factory PracticeAttempt({
    required String id,
    @JsonKey(name: 'problem_id') required String problemId,
    @JsonKey(name: 'answered_at') required DateTime answeredAt,
    required String response,
    required PracticeVerdict verdict,
    @JsonKey(name: 'graded_by') required String gradedBy,
    required String? comment,
  }) = _PracticeAttempt;

  factory PracticeAttempt.fromJson(Map<String, dynamic> json) =>
      _$PracticeAttemptFromJson(json);
}

/// 復習問題の通知予約。画面の文言は [days] を使い、段番号から日数を推測しない。
@freezed
abstract class PracticeScheduleEntry with _$PracticeScheduleEntry {
  const factory PracticeScheduleEntry({
    @JsonKey(name: 'problem_id') required String problemId,
    required int step,
    required int days,
    @JsonKey(name: 'scheduled_at') required DateTime scheduledAt,
  }) = _PracticeScheduleEntry;

  factory PracticeScheduleEntry.fromJson(Map<String, dynamic> json) =>
      _$PracticeScheduleEntryFromJson(json);
}

@freezed
abstract class PracticeQueueItem with _$PracticeQueueItem {
  const factory PracticeQueueItem({
    required PracticeProblem problem,
    @JsonKey(name: 'days_since') required int daysSince,
    @JsonKey(name: 'topic_label') required String topicLabel,
    @JsonKey(name: 'last_verdict') required PracticeVerdict? lastVerdict,
  }) = _PracticeQueueItem;

  factory PracticeQueueItem.fromJson(Map<String, dynamic> json) =>
      _$PracticeQueueItemFromJson(json);
}

/// 正解した問題の直近履歴。ホームの通算値は [Progress.solvedProblems] が正。
@freezed
abstract class SolvedPractice with _$SolvedPractice {
  const factory SolvedPractice({
    required PracticeProblem problem,
    @JsonKey(name: 'topic_label') required String topicLabel,
    @JsonKey(name: 'days_since_solved') required int daysSinceSolved,
  }) = _SolvedPractice;

  factory SolvedPractice.fromJson(Map<String, dynamic> json) =>
      _$SolvedPracticeFromJson(json);
}

@freezed
abstract class PracticeQueue with _$PracticeQueue {
  const PracticeQueue._();

  const factory PracticeQueue({
    required List<PracticeQueueItem> items,
    @Default(<SolvedPractice>[]) List<SolvedPractice> solved,
  }) = _PracticeQueue;

  factory PracticeQueue.fromJson(Map<String, dynamic> json) =>
      _$PracticeQueueFromJson(json);

  bool get isEmpty => items.isEmpty && solved.isEmpty;
}

/// `POST /v1/me/practice/{problemId}` の応答。
@freezed
abstract class PracticeAnswer with _$PracticeAnswer {
  const factory PracticeAnswer({
    required PracticeAttempt attempt,
    @JsonKey(name: 'next_schedule')
    required List<PracticeScheduleEntry> nextSchedule,
    required Progress progress,
  }) = _PracticeAnswer;

  factory PracticeAnswer.fromJson(Map<String, dynamic> json) =>
      _$PracticeAnswerFromJson(json);
}
