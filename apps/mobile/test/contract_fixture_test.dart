import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:flutter_test/flutter_test.dart';

/// 契約ドリフトの検知(Dart側)。
///
/// TypeScript側は `packages/contract/src/fixtures.test.ts` が同じファイルを
/// zodでパースしている。**両方が通って初めて契約が揃っている**と言える。
/// 片側だけスキーマを変えると、ここか向こうが落ちる。
Map<String, dynamic> loadFixture(String name) {
  final File file = File('../../packages/contract/fixtures/$name.json');
  expect(file.existsSync(), isTrue, reason: '${file.path} が見つかりません');
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  group('カルテのfixture', () {
    test('karte.json をパースできる', () {
      final Karte karte = Karte.fromJson(loadFixture('karte'));

      expect(karte.id, isNotEmpty);
      expect(karte.saidWell, isNotEmpty);
      expect(karte.holes, hasLength(1));
      expect(karte.holes.first.topicId, 'M1-NIJI-HANBETSU');
      expect(karte.holes.first.severity, HoleSeverity.medium);
      expect(karte.holes.first.status, HoleStatus.open);
      expect(karte.holes.first.filledAt, isNull);
    });

    test('あと追い質問がnullでも読める(無料ユーザー)', () {
      expect(Karte.fromJson(loadFixture('karte')).followupQuestion, isNull);
    });
  });

  group('セッションのfixture', () {
    test('create-session-response.json をパースできる', () {
      final SessionStart session = SessionStart.fromJson(loadFixture('create-session-response'));

      expect(session.sessionId, isNotEmpty);
      expect(session.livekit.room, session.sessionId);
      expect(session.detectedTopics, hasLength(2));
      expect(session.limits.maxSeconds, 300);
      expect(session.limits.isUnlimited, isFalse);
    });

    test('確信度の低い候補を見分けられる(チップの初期選択に使う)', () {
      final SessionStart session = SessionStart.fromJson(loadFixture('create-session-response'));

      expect(session.detectedTopics.first.isConfident, isTrue);
      expect(session.detectedTopics.last.isConfident, isFalse);
    });

    test('complete-session-response.json をパースできる', () {
      final SessionResult result = SessionResult.fromJson(
        loadFixture('complete-session-response'),
      );

      expect(result.karte.holes, hasLength(1));
      expect(result.progress.streakDays, 3);
      expect(result.progress.filledHoles, 4);
      expect(result.showPaywall, isTrue);
    });
  });

  group('進捗と復習のfixture', () {
    test('progress-response.json をパースできる', () {
      final Progress progress = Progress.fromJson(
        loadFixture('progress-response')['progress'] as Map<String, dynamic>,
      );

      expect(progress.streakDays, 3);
      expect(progress.openHoles, 1);
      expect(progress.lastSessionDate, '2026-08-03');
    });

    test('review-queue-response.json をパースできる', () {
      final ReviewQueue queue = ReviewQueue.fromJson(loadFixture('review-queue-response'));

      expect(queue.requiresPremium, isFalse);
      expect(queue.items, hasLength(2));
      expect(queue.items.first.daysSince, 3);
      expect(queue.items.first.prompt, contains('いまなら説明できますか'));
    });
  });

  group('設計上の約束', () {
    // 点数のフィールドが生えたら、fixtureに現れる前にここで気づきたい
    test('カルテのfixtureに点数・正答率のキーがない', () {
      final Map<String, dynamic> karte = loadFixture('karte');

      for (final String forbidden in <String>['score', 'accuracy', 'rate', 'points', 'level']) {
        expect(karte.containsKey(forbidden), isFalse, reason: '$forbidden は持たない');
      }
    });

    test('進捗が数えるのは連続日数と穴だけ', () {
      final Map<String, dynamic> progress =
          loadFixture('progress-response')['progress'] as Map<String, dynamic>;

      expect(
        progress.keys.toSet(),
        <String>{'streak_days', 'filled_holes', 'open_holes', 'last_session_date'},
      );
    });
  });
}
