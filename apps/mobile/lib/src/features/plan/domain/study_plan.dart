import 'package:freezed_annotation/freezed_annotation.dart';

import '../../session/domain/session.dart';

part 'study_plan.freezed.dart';
part 'study_plan.g.dart';

/// 学習計画のモデル。正は `packages/contract/src/plan.ts`。
///
/// 日付を [DateTime] にしないのは、契約の `YYYY-MM-DD` が「端末の暦の日」であって
/// UTC上の瞬間ではないため。JSON変換のタイムゾーンで前日に動かす余地を作らず、
/// 表示するときだけローカル日付として解釈する。

enum PlanSource {
  @JsonValue('senpai')
  senpai,
  @JsonValue('template')
  template,
}

enum PlanItemStatus {
  @JsonValue('todo')
  todo,
  @JsonValue('done')
  done,
  @JsonValue('moved')
  moved,
}

enum PlanRevisionReason {
  @JsonValue('behind')
  behind,
  @JsonValue('ahead')
  ahead,
  @JsonValue('facts_changed')
  factsChanged,
}

@freezed
abstract class PlanScope with _$PlanScope {
  const factory PlanScope({
    @JsonKey(name: 'topic_ids') required List<String> topicIds,
    required String said,
  }) = _PlanScope;

  factory PlanScope.fromJson(Map<String, dynamic> json) =>
      _$PlanScopeFromJson(json);
}

@freezed
abstract class PlanIntake with _$PlanIntake {
  const factory PlanIntake({
    @JsonKey(name: 'exam_name') required String examName,
    @JsonKey(name: 'exam_date') required String examDate,
    required PlanScope scope,
    required List<String> materials,
  }) = _PlanIntake;

  factory PlanIntake.fromJson(Map<String, dynamic> json) =>
      _$PlanIntakeFromJson(json);
}

@freezed
abstract class PlanItem with _$PlanItem {
  const factory PlanItem({
    @JsonKey(name: 'topic_id') required String topicId,
    required String what,
    required int? material,
    required int minutes,
    required PlanItemStatus status,
  }) = _PlanItem;

  factory PlanItem.fromJson(Map<String, dynamic> json) =>
      _$PlanItemFromJson(json);
}

@freezed
abstract class PlanDay with _$PlanDay {
  const factory PlanDay({required String date, required List<PlanItem> items}) =
      _PlanDay;

  factory PlanDay.fromJson(Map<String, dynamic> json) =>
      _$PlanDayFromJson(json);
}

@freezed
abstract class PlanRevision with _$PlanRevision {
  const factory PlanRevision({
    required String at,
    required PlanRevisionReason reason,
    required String? said,
  }) = _PlanRevision;

  factory PlanRevision.fromJson(Map<String, dynamic> json) =>
      _$PlanRevisionFromJson(json);
}

@freezed
abstract class StudyPlan with _$StudyPlan {
  const factory StudyPlan({
    required String id,
    @JsonKey(name: 'created_at') required String createdAt,
    required PlanSource source,
    required PlanIntake intake,
    required List<PlanDay> days,
    required List<PlanRevision> revisions,
  }) = _StudyPlan;

  factory StudyPlan.fromJson(Map<String, dynamic> json) =>
      _$StudyPlanFromJson(json);
}

@freezed
abstract class PlanSessionStart with _$PlanSessionStart {
  const factory PlanSessionStart({
    @JsonKey(name: 'plan_session_id') required String planSessionId,
    required LiveKitConnection livekit,
    @JsonKey(name: 'current_plan') required StudyPlan? currentPlan,
  }) = _PlanSessionStart;

  factory PlanSessionStart.fromJson(Map<String, dynamic> json) =>
      _$PlanSessionStartFromJson(json);
}
