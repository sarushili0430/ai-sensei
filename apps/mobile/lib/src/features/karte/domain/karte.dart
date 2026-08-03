import 'package:flutter/foundation.dart';

/// カルテのモデル。
///
/// 正は `packages/contract`(zod + JSON Schema)。Dart側は手書きで、
/// `test/contract_fixture_test.dart` が同じfixtureをパースして契約ドリフトを検知する。
///
/// **点数・正答率のフィールドは持たない。** 数えるのは連続日数と埋めた穴だけ。
/// 解答・解説を入れる場所も用意しない(答えを教えないため)。

enum HoleSeverity { low, medium, high }

HoleSeverity _severityFrom(String value) => switch (value) {
      'high' => HoleSeverity.high,
      'medium' => HoleSeverity.medium,
      _ => HoleSeverity.low,
    };

enum HoleStatus { open, filled }

@immutable
class Hole {
  const Hole({
    required this.id,
    required this.topicId,
    required this.description,
    required this.severity,
    required this.status,
    required this.createdAt,
    this.evidence,
    this.filledAt,
  });

  factory Hole.fromJson(Map<String, dynamic> json) => Hole(
        id: json['id'] as String,
        topicId: json['topic_id'] as String,
        description: json['desc'] as String,
        severity: _severityFrom(json['severity'] as String),
        status: json['status'] == 'filled' ? HoleStatus.filled : HoleStatus.open,
        createdAt: DateTime.parse(json['created_at'] as String),
        evidence: json['evidence'] as String?,
        filledAt: json['filled_at'] == null
            ? null
            : DateTime.parse(json['filled_at'] as String),
      );

  final String id;
  final String topicId;

  /// 「〜で説明が止まった」の形。責める文体にしない。
  final String description;
  final HoleSeverity severity;
  final HoleStatus status;
  final DateTime createdAt;
  final String? evidence;
  final DateTime? filledAt;
}

@immutable
class Karte {
  const Karte({
    required this.id,
    required this.sessionId,
    required this.createdAt,
    required this.topicIds,
    required this.saidWell,
    required this.holes,
    required this.termNotes,
    this.followupQuestion,
  });

  factory Karte.fromJson(Map<String, dynamic> json) => Karte(
        id: json['id'] as String,
        sessionId: json['session_id'] as String,
        createdAt: DateTime.parse(json['created_at'] as String),
        topicIds: (json['topic_ids'] as List<dynamic>).cast<String>(),
        saidWell: (json['said_well'] as List<dynamic>).cast<String>(),
        holes: (json['holes'] as List<dynamic>)
            .map((dynamic it) => Hole.fromJson(it as Map<String, dynamic>))
            .toList(growable: false),
        termNotes: (json['term_notes'] as List<dynamic>).cast<String>(),
        followupQuestion: json['followup_question'] as String?,
      );

  final String id;
  final String sessionId;
  final DateTime createdAt;
  final List<String> topicIds;

  /// 言えたこと。黄色のマーカーで示す。
  final List<String> saidWell;

  /// 穴。ピンクのマーカーで示す。失点ではなく、これから埋まる場所。
  final List<Hole> holes;
  final List<String> termNotes;

  /// 後輩のあと追い質問(Premiumのみ)。
  final String? followupQuestion;
}

@immutable
class Progress {
  const Progress({
    required this.streakDays,
    required this.filledHoles,
    required this.openHoles,
    this.lastSessionDate,
  });

  factory Progress.fromJson(Map<String, dynamic> json) => Progress(
        streakDays: json['streak_days'] as int,
        filledHoles: json['filled_holes'] as int,
        openHoles: json['open_holes'] as int,
        lastSessionDate: json['last_session_date'] as String?,
      );

  static const Progress empty =
      Progress(streakDays: 0, filledHoles: 0, openHoles: 0);

  final int streakDays;
  final int filledHoles;
  final int openHoles;
  final String? lastSessionDate;
}

@immutable
class ReviewQueueItem {
  const ReviewQueueItem({
    required this.hole,
    required this.daysSince,
    required this.prompt,
  });

  factory ReviewQueueItem.fromJson(Map<String, dynamic> json) => ReviewQueueItem(
        hole: Hole.fromJson(json['hole'] as Map<String, dynamic>),
        daysSince: json['days_since'] as int,
        prompt: json['prompt'] as String,
      );

  final Hole hole;
  final int daysSince;

  /// 後輩の声のひとこと。通知文と同じ。
  final String prompt;
}

@immutable
class ReviewQueue {
  const ReviewQueue({required this.items, required this.requiresPremium});

  factory ReviewQueue.fromJson(Map<String, dynamic> json) => ReviewQueue(
        items: (json['items'] as List<dynamic>)
            .map((dynamic it) => ReviewQueueItem.fromJson(it as Map<String, dynamic>))
            .toList(growable: false),
        requiresPremium: json['requires_premium'] as bool,
      );

  final List<ReviewQueueItem> items;
  final bool requiresPremium;
}
