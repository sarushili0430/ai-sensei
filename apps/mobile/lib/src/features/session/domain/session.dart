import 'package:flutter/foundation.dart';

import '../../karte/domain/karte.dart';

/// セッション関連のモデル。正は `packages/contract`。

@immutable
class DetectedTopic {
  const DetectedTopic({
    required this.topicId,
    required this.course,
    required this.unit,
    required this.topic,
    required this.confidence,
  });

  factory DetectedTopic.fromJson(Map<String, dynamic> json) => DetectedTopic(
        topicId: json['topic_id'] as String,
        course: json['course'] as String,
        unit: json['unit'] as String,
        topic: json['topic'] as String,
        confidence: (json['confidence'] as num).toDouble(),
      );

  final String topicId;
  final String course;
  final String unit;
  final String topic;

  /// 0..1。低いものは選択済みにせず、候補として並べるだけにする。
  final double confidence;

  bool get isConfident => confidence >= 0.5;
}

@immutable
class LiveKitConnection {
  const LiveKitConnection({required this.url, required this.token, required this.room});

  factory LiveKitConnection.fromJson(Map<String, dynamic> json) => LiveKitConnection(
        url: json['url'] as String,
        token: json['token'] as String,
        room: json['room'] as String,
      );

  final String url;
  final String token;
  final String room;
}

@immutable
class SessionLimits {
  const SessionLimits({required this.maxSeconds, this.remainingSessionsToday});

  factory SessionLimits.fromJson(Map<String, dynamic> json) => SessionLimits(
        maxSeconds: json['max_seconds'] as int,
        remainingSessionsToday: json['remaining_sessions_today'] as int?,
      );

  final int maxSeconds;

  /// Premiumはnull(無制限)。
  final int? remainingSessionsToday;

  bool get isUnlimited => remainingSessionsToday == null;
}

@immutable
class SessionStart {
  const SessionStart({
    required this.sessionId,
    required this.kind,
    required this.livekit,
    required this.detectedTopics,
    required this.limits,
  });

  factory SessionStart.fromJson(Map<String, dynamic> json) => SessionStart(
        sessionId: json['session_id'] as String,
        kind: json['kind'] as String,
        livekit: LiveKitConnection.fromJson(json['livekit'] as Map<String, dynamic>),
        detectedTopics: (json['detected_topics'] as List<dynamic>)
            .map((dynamic it) => DetectedTopic.fromJson(it as Map<String, dynamic>))
            .toList(growable: false),
        limits: SessionLimits.fromJson(json['limits'] as Map<String, dynamic>),
      );

  final String sessionId;
  final String kind;
  final LiveKitConnection livekit;
  final List<DetectedTopic> detectedTopics;
  final SessionLimits limits;
}

/// セッション終了後に受け取る結果。
@immutable
class SessionResult {
  const SessionResult({
    required this.karte,
    required this.progress,
    required this.showPaywall,
  });

  factory SessionResult.fromJson(Map<String, dynamic> json) => SessionResult(
        karte: Karte.fromJson(json['karte'] as Map<String, dynamic>),
        progress: Progress.fromJson(json['progress'] as Map<String, dynamic>),
        showPaywall: json['show_paywall'] as bool,
      );

  final Karte karte;
  final Progress progress;

  /// 初回カルテで穴が見えた直後だけ true。
  final bool showPaywall;
}
