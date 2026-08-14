import 'package:freezed_annotation/freezed_annotation.dart';

part 'parent_report.freezed.dart';
part 'parent_report.g.dart';

/// Parent report model; `packages/contract/src/parent-report.ts` is the
/// source of truth.
///
/// No fields for accuracy, comprehension scores, ranking or study time.
/// Hiding them at render time is not enough — the layer building the share
/// text could still reach them — so the shape that cannot carry them is
/// mirrored here too.
@freezed
abstract class ParentReportPeriod with _$ParentReportPeriod {
  const factory ParentReportPeriod({
    @JsonKey(name: 'start_date') required DateTime startDate,
    @JsonKey(name: 'end_date') required DateTime endDate,
  }) = _ParentReportPeriod;

  factory ParentReportPeriod.fromJson(Map<String, dynamic> json) =>
      _$ParentReportPeriodFromJson(json);
}

@freezed
abstract class ParentReportTopic with _$ParentReportTopic {
  const factory ParentReportTopic({
    @JsonKey(name: 'topic_id') required String topicId,
    required String name,
  }) = _ParentReportTopic;

  factory ParentReportTopic.fromJson(Map<String, dynamic> json) =>
      _$ParentReportTopicFromJson(json);
}

@freezed
abstract class ParentReport with _$ParentReport {
  const factory ParentReport({
    required ParentReportPeriod period,
    @JsonKey(name: 'filled_holes') required int filledHoles,
    @JsonKey(name: 'streak_days') required int streakDays,
    @JsonKey(name: 'explained_topics')
    required List<ParentReportTopic> explainedTopics,

    /// The student's own words, sourced from the karte's `said_well`. All of
    /// them are shown on screen before sharing.
    required List<String> quotes,
  }) = _ParentReport;

  factory ParentReport.fromJson(Map<String, dynamic> json) =>
      _$ParentReportFromJson(json);
}

@freezed
abstract class ParentReportResponse with _$ParentReportResponse {
  const ParentReportResponse._();

  const factory ParentReportResponse({
    @JsonKey(name: 'requires_premium') required bool requiresPremium,

    /// Null for free users. We never fetch the body and hide it client-side.
    required ParentReport? report,
  }) = _ParentReportResponse;

  factory ParentReportResponse.fromJson(Map<String, dynamic> json) =>
      _$ParentReportResponseFromJson(json);

  static const ParentReportResponse locked = ParentReportResponse(
    requiresPremium: true,
    report: null,
  );
}
