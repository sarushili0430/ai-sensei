import 'package:freezed_annotation/freezed_annotation.dart';

part 'parent_report.freezed.dart';
part 'parent_report.g.dart';

/// 親レポートのモデル。
///
/// 正は `packages/contract/src/parent-report.ts`。この型には正答率・理解度スコア・
/// 順位・学習時間を置く欄を作らない。表示で隠すだけでは、共有本文を組み立てる層が
/// いつか使えてしまうため、モバイル側にも「受け取れない形」を写しておく。
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

    /// カルテの `said_well` を出どころにした本人の言葉。画面で全件を見せてから共有する。
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

    /// 無料ユーザーには null。本文を先に取得してクライアントだけで隠す形にしない。
    required ParentReport? report,
  }) = _ParentReportResponse;

  factory ParentReportResponse.fromJson(Map<String, dynamic> json) =>
      _$ParentReportResponseFromJson(json);

  static const ParentReportResponse locked = ParentReportResponse(
    requiresPremium: true,
    report: null,
  );
}
