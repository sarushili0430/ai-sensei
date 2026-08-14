import 'package:ai_sensei/src/telemetry/telemetry.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

/// Degradation monitoring.
///
/// These check not whether Sentry received anything but the promises that hold
/// before it is sent:
///
///   - builds without a DSN do nothing (local and CI behave the same)
///   - the same thing is not reported repeatedly (a lesson streams dozens of
///     steps)
///   - content is never sent (users are minors: photos, speech, kartes, problem
///     text)
void main() {
  group('DSN が無いビルド', () {
    test('監視は無効。初期化も送信もしない', () {
      // Run without `--dart-define=SENTRY_DSN`, so this is always the case.
      expect(SentryConfig.dsn, isEmpty);
      expect(SentryConfig.isConfigured, isFalse);
    });

    test('report を呼んでも落ちない(アプリの挙動を変えない)', () {
      expect(
        () => Telemetry.report(
          DegradationEvent.boardGap(
            sessionId: 'ses_1',
            boardId: 'brd_1',
            reason: 'seq が飛びました',
            stepsSoFar: 2,
          ),
        ),
        returnsNormally,
      );
    });

    test('起動は監視の有無に関わらず通る', () async {
      bool started = false;
      await Telemetry.runWithMonitoring(() => started = true);
      expect(started, isTrue);
    });
  });

  group('間引き', () {
    test('同じ鍵は1度だけ通す', () {
      final DegradationThrottle throttle = DegradationThrottle();

      expect(throttle.allow('board_gap/brd_1'), isTrue);
      expect(throttle.allow('board_gap/brd_1'), isFalse);
      expect(throttle.allow('board_gap/brd_1'), isFalse);
    });

    test('板書が変われば別件として通す', () {
      final DegradationThrottle throttle = DegradationThrottle();

      expect(throttle.allow('board_gap/brd_1'), isTrue);
      expect(throttle.allow('board_gap/brd_2'), isTrue);
    });

    test('種類が違えば別件として通す', () {
      final DegradationThrottle throttle = DegradationThrottle();

      expect(throttle.allow('board_gap/brd_1'), isTrue);
      expect(throttle.allow('latex_scale_floor/brd_1'), isTrue);
    });

    // Remembering without bound grows only this on a long-running device, so at
    // the cap it forgets and each key sends once more.
    test('覚える鍵には上限があり、超えたら忘れる', () {
      final DegradationThrottle throttle = DegradationThrottle(limit: 3);

      expect(throttle.allow('a'), isTrue);
      expect(throttle.allow('b'), isTrue);
      expect(throttle.allow('c'), isTrue);
      expect(throttle.allow('a'), isFalse, reason: 'まだ覚えている');

      // It forgets at the fourth, so `a` passes again: over-reporting beats going
      // silent.
      expect(throttle.allow('d'), isTrue);
      expect(throttle.allow('a'), isTrue);
    });
  });

  group('本文を送らない(ユーザーは未成年)', () {
    // `enablePrintBreadcrumbs` defaults to true, turning `debugPrint` output into
    // breadcrumbs. Ours carries full `tex` and karte fetch failures, so this is
    // the last gate.
    test('パンくずは1つ残らず落とす', () {
      final SentryEvent event = SentryEvent(
        breadcrumbs: <Breadcrumb>[
          Breadcrumb(message: '判別式は、解が何個あるか調べるやつです'),
          Breadcrumb(message: 'カルテを受け取れませんでした'),
        ],
      );

      final SentryEvent? scrubbed = scrubEvent(event, Hint());

      expect(scrubbed, isNotNull);
      expect(scrubbed!.breadcrumbs, isEmpty);
    });

    test('リクエスト(URL)も落とす', () {
      final SentryEvent event = SentryEvent(
        request: SentryRequest(url: 'https://example.test/v1/sessions'),
      );

      expect(scrubEvent(event, Hint())!.request, isNull);
    });

    // Dropping the event would make degradations unobservable; drop the contents
    // only.
    test('イベントそのものは落とさない', () {
      expect(scrubEvent(SentryEvent(), Hint()), isNotNull);
    });
  });

  /// What is pinned is not "the pass wording is not sent" but "no user-authored
  /// free text reaches a degradation payload at all". The former guards one
  /// place; the latter guards the fifth kind we have not written yet.
  ///
  /// Structurally, `DegradationEvent`'s constructor is private and only the named
  /// factories can build one (`Telemetry.report` takes no raw Map). These tests
  /// check what those factories actually let through.
  group('payload に自由文が入らない', () {
    /// Poison standing in for speech, karte and problem text. It must appear
    /// nowhere.
    const String poison = '判別式は、解が何個あるか調べるやつです。円 x^2 + y^2 = 5 と直線 y = x + k について…';

    /// Every kind the factories can build. Adding a fifth means adding it here.
    List<DegradationEvent> allEvents() => <DegradationEvent>[
      DegradationEvent.boardGap(
        sessionId: 'ses_1',
        boardId: 'brd_1',
        reason: 'seq は0始まりで1ずつ増やしてください(seq=3, 期待値=2)',
        stepsSoFar: 2,
      ),
      DegradationEvent.latexScaleFloor(
        tex: r'D = (-4)^2 - 4k > 0',
        scale: 0.42,
        minScale: 0.7,
        availableWidth: 198,
        naturalWidth: 470,
      ),
      DegradationEvent.boardTooNarrow(availableWidth: 198, assumedWidth: 340),
      DegradationEvent.passNotSent(
        sessionId: 'ses_1',
        phase: 'explainBack',
        error: StateError,
      ),
    ];

    test('値は数値・真偽・文字列だけ(入れ子を持ち込まない)', () {
      for (final DegradationEvent event in allEvents()) {
        for (final MapEntry<String, Object?> entry in event.data.entries) {
          expect(
            entry.value,
            anyOf(isNull, isA<num>(), isA<bool>(), isA<String>()),
            reason: '${event.kind.id} の ${entry.key}',
          );
        }
      }
    });

    test('どの文字列も上限を超えない(発話やカルテが丸ごと入らない)', () {
      for (final DegradationEvent event in allEvents()) {
        for (final MapEntry<String, Object?> entry in event.data.entries) {
          if (entry.value is! String) continue;
          expect(
            (entry.value! as String).length,
            lessThanOrEqualTo(maxFieldLength + 1), // allows for the ellipsis
            reason: '${event.kind.id} の ${entry.key}',
          );
        }
      }
    });

    // The violation reason is a diagnostic we assembled (seq and index), but if
    // content ever slips in, the amount that escapes is still capped.
    test('長すぎる診断文は切り落とす', () {
      final DegradationEvent event = DegradationEvent.boardGap(
        sessionId: 'ses_1',
        boardId: 'brd_1',
        reason: poison * 10,
        stepsSoFar: 0,
      );

      final String reason = event.data['reason']! as String;
      expect(reason.length, maxFieldLength + 1);
      expect(reason.endsWith('…'), isTrue);
    });

    /// `tex` is the one exception: it is a formula, so it may be sent, but it is
    /// still truncated inside the factory, so a caller passing the whole string
    /// leaks nothing.
    test('tex だけが本文を持てる。それでも先頭だけに切られる', () {
      final DegradationEvent event = DegradationEvent.latexScaleFloor(
        tex: 'x' * 500,
        scale: 0.4,
        minScale: 0.7,
        availableWidth: 198,
        naturalWidth: 900,
      );

      final String tex = event.data['tex']! as String;
      expect(tex.length, texPrefixLength + 1);
      expect(tex.endsWith('…'), isTrue);
    });

    // The factory accepts only a `Type`, so an exception's `toString()` (which
    // can contain endpoint URLs or token fragments) cannot be passed.
    test('パスの失敗は、例外の型名しか持たない', () {
      final DegradationEvent event = DegradationEvent.passNotSent(
        sessionId: 'ses_1',
        phase: 'explainBack',
        error: StateError,
      );

      expect(event.data['error'], 'StateError');
      // There is no parameter for the pass wording, so it cannot be passed.
      expect(event.data.keys, <String>['session_id', 'phase', 'error']);
    });

    test('板書の幅は数値しか持たない', () {
      final DegradationEvent event =
          DegradationEvent.boardTooNarrow(availableWidth: 198, assumedWidth: 340);

      expect(event.data.values.every((Object? v) => v is num), isTrue);
    });
  });

  group('間引きの鍵', () {
    test('板書がとぎれたら board_id ごと。取れなければセッション単位', () {
      expect(
        DegradationEvent.boardGap(
          sessionId: 'ses_1',
          boardId: 'brd_1',
          reason: 'r',
          stepsSoFar: 0,
        ).dedupeKey,
        'brd_1',
      );
      // Broken before even `board_open` was readable; falls back to one per
      // session.
      expect(
        DegradationEvent.boardGap(
          sessionId: 'ses_1',
          boardId: null,
          reason: 'r',
          stepsSoFar: 0,
        ).dedupeKey,
        'ses_1',
      );
    });

    // Getting stuck repeatedly in one conversation is normal; reporting each time
    // would bury the real signal that the send path is broken.
    test('パスの失敗は1セッションに1件', () {
      expect(
        DegradationEvent.passNotSent(
          sessionId: 'ses_1',
          phase: 'explainBack',
          error: StateError,
        ).dedupeKey,
        'ses_1',
      );
    });
  });

  group('tex の切り詰め', () {
    test('短い式はそのまま', () {
      expect(truncateTex('D = b^2 - 4ac'), 'D = b^2 - 4ac');
    });

    test('長い式は先頭だけにして、切ったことが分かるようにする', () {
      final String long = 'x' * (texPrefixLength + 50);
      final String cut = truncateTex(long);

      expect(cut.length, texPrefixLength + 1);
      expect(cut.endsWith('…'), isTrue);
      expect(long.startsWith(cut.substring(0, texPrefixLength)), isTrue);
    });
  });

  group('縮退の種類', () {
    // Used for search and grouping in Sentry, so it stays ASCII.
    test('IDは英数字のまま', () {
      for (final Degradation kind in Degradation.values) {
        expect(kind.id, matches(RegExp(r'^[a-z_]+$')), reason: '${kind.name} の id');
      }
    });

    test('IDは重複しない(Sentry側で別々に数えられる)', () {
      final Set<String> ids = Degradation.values.map((Degradation k) => k.id).toSet();
      expect(ids, hasLength(Degradation.values.length));
    });

    /// The promise that passing is not shameful holds only because a pass is
    /// recorded. A failed send never becomes a gap, and the screen carries on as
    /// if fine, so neither side can see it. This kind makes it visible.
    test('パスが送れなかったことを記録する種類がある', () {
      expect(Degradation.values, contains(Degradation.passNotSent));
      expect(Degradation.passNotSent.id, 'pass_not_sent');
    });
  });
}
