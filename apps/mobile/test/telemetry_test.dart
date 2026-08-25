import 'package:ai_sensei/src/telemetry/telemetry.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

/// 縮退の監視(計画書 §10-7)。
///
/// ここで見ているのは「Sentryに届いたか」ではなく、**届く前に守るべき約束**:
///
///   - DSN が無いビルドでは何もしない(手元とCIの挙動を変えない)
///   - 同じことを連発しない(1回の授業で何十手順も流れる)
///   - **本文を送らない**(ユーザーは未成年。写真・発話・カルテ・問題文)
void main() {
  group('DSN が無いビルド', () {
    test('監視は無効。初期化も送信もしない', () {
      // `--dart-define=SENTRY_DSN` を渡さずに走らせているので、常にこちら。
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

    // 無制限に覚えると、長く使った人の端末でここだけが太り続ける。
    // 上限に達したら忘れる(= そこから先はもう一度だけ送る)。
    test('覚える鍵には上限があり、超えたら忘れる', () {
      final DegradationThrottle throttle = DegradationThrottle(limit: 3);

      expect(throttle.allow('a'), isTrue);
      expect(throttle.allow('b'), isTrue);
      expect(throttle.allow('c'), isTrue);
      expect(throttle.allow('a'), isFalse, reason: 'まだ覚えている');

      // 4件目で忘れる。そのあとは a も通る = 送りすぎより「何も飛ばなくなる」を避ける。
      expect(throttle.allow('d'), isTrue);
      expect(throttle.allow('a'), isTrue);
    });
  });

  group('本文を送らない(ユーザーは未成年)', () {
    // `enablePrintBreadcrumbs` の既定は true で、`debugPrint` の出力が
    // そのままパンくずになる。このアプリの `debugPrint` には `tex` の全文や
    // カルテ取得の失敗理由が入っているので、**ここが最後の関門**。
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

    // イベントごと落とすと縮退が観測できなくなる。落とすのは中身だけ。
    test('イベントそのものは落とさない', () {
      expect(scrubEvent(SentryEvent(), Hint()), isNotNull);
    });
  });

  /// **固定したいのは「パスの文言を送っていない」ではない。**
  /// 「縮退の payload に、ユーザー由来の自由文が1つも入らない」ほう。
  /// 前者は1か所を守るが、後者は**これから足されるすべての種類も守る**。
  ///
  /// 構造としては `DegradationEvent` のコンストラクタが private で、
  /// 名前つきの生成子からしか作れないことが担保になっている
  /// (`Telemetry.report` は生のMapを受け取らない)。ここではその生成子が
  /// 実際に何を通すかを見る。
  group('payload に自由文が入らない', () {
    /// 発話・カルテ・問題文のつもりの毒。**どこにも現れてはいけない。**
    const String poison = '判別式は、解が何個あるか調べるやつです。円 x^2 + y^2 = 5 と直線 y = x + k について…';

    /// 生成子が作れる全種類。**種類を足したらここにも足すこと。**
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
      DegradationEvent.figureSvgFailed(svgLength: 1234, error: FormatException),
      DegradationEvent.passNotSent(
        sessionId: 'ses_1',
        phase: 'explainBack',
        error: StateError,
      ),
      DegradationEvent.solvingReportNotSent(
        sessionId: 'ses_1',
        phase: 'senpaiTeaching',
        error: StateError,
      ),
      DegradationEvent.understoodNotSent(
        sessionId: 'ses_1',
        phase: 'senpaiTeaching',
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
            lessThanOrEqualTo(maxFieldLength + 1), // 切ったときの「…」ぶん
            reason: '${event.kind.id} の ${entry.key}',
          );
        }
      }
    });

    // 契約違反の理由は**こちらが組み立てた診断文**(seq と index の話)だが、
    // 将来そこに本文が混ざる書き方をしても、流れる量は切り落とされる。
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

    /// **唯一の例外が `tex`。** 中身は数式なので送ってよいが、それでも切る。
    /// 切るのは生成子の内側なので、**呼び出し側が全文を渡しても外には出ない。**
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

    // 生成子が `Type` しか受け取らないので、例外の `toString()`
    // (接続先URLやトークンの断片を含みうる)は渡しようがない。
    test('パスの失敗は、例外の型名しか持たない', () {
      final DegradationEvent event = DegradationEvent.passNotSent(
        sessionId: 'ses_1',
        phase: 'explainBack',
        error: StateError,
      );

      expect(event.data['error'], 'StateError');
      // パスの文言を渡す引数が無い = 渡しようがない。
      expect(event.data.keys, <String>['session_id', 'phase', 'error']);
    });

    test('「わかった」の失敗も、例外の型名しか持たない', () {
      final DegradationEvent event = DegradationEvent.understoodNotSent(
        sessionId: 'ses_1',
        phase: 'senpaiTeaching',
        error: StateError,
      );

      expect(event.data, <String, Object?>{
        'session_id': 'ses_1',
        'phase': 'senpaiTeaching',
        'error': 'StateError',
      });
    });

    test('途中で切れた会話は、理由(enum名)と残り時間しか持たない', () {
      final DegradationEvent event = DegradationEvent.sessionDropped(
        sessionId: 'ses_1',
        reason: 'signalingConnectionFailure',
        remainingSeconds: 660,
        phase: 'explainBack',
      );

      expect(event.data, <String, Object?>{
        'session_id': 'ses_1',
        'reason': 'signalingConnectionFailure',
        'remaining_seconds': 660,
        'phase': 'explainBack',
      });
      expect(event.data.values, isNot(contains(poison)));
    });

    test('板書の幅は数値しか持たない', () {
      final DegradationEvent event =
          DegradationEvent.boardTooNarrow(availableWidth: 198, assumedWidth: 340);

      expect(event.data.values.every((Object? v) => v is num), isTrue);
    });

    test('SVGの失敗は本文を持たず、長さと例外型だけを持つ', () {
      final DegradationEvent event = DegradationEvent.figureSvgFailed(
        svgLength: 1234,
        error: FormatException,
      );

      expect(event.data, <String, Object?>{
        'svg_length': 1234,
        'error': 'FormatException',
      });
      expect(event.data.values, isNot(contains(poison)));
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
      // `board_open` すら読めずに壊れた場合。1セッションに1件へ落ちる。
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

    // 同じ会話で何度も詰まるのは**正常**。詰まるたびに飛ばすと、
    // 本当に見たい「送信経路が壊れている」が件数に埋もれる。
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

    test('「わかった」の失敗も1セッションに1件', () {
      expect(
        DegradationEvent.understoodNotSent(
          sessionId: 'ses_1',
          phase: 'senpaiTeaching',
          error: StateError,
        ).dedupeKey,
        'ses_1',
      );
    });

    test('SVGの失敗は例外型と本文長が同じ再buildを1件にする', () {
      final DegradationEvent event = DegradationEvent.figureSvgFailed(
        svgLength: 100,
        error: FormatException,
      );

      expect(event.dedupeKey, 'FormatException/100');
      expect(
        DegradationEvent.figureSvgFailed(
          svgLength: 101,
          error: FormatException,
        ).dedupeKey,
        isNot(event.dedupeKey),
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
    // Sentry 上の検索とグルーピングに使うので、日本語にしない。
    test('IDは英数字のまま', () {
      for (final Degradation kind in Degradation.values) {
        expect(kind.id, matches(RegExp(r'^[a-z_]+$')), reason: '${kind.name} の id');
      }
    });

    test('IDは重複しない(Sentry側で別々に数えられる)', () {
      final Set<String> ids = Degradation.values.map((Degradation k) => k.id).toSet();
      expect(ids, hasLength(Degradation.values.length));
    });

    /// 約束3(パスを恥にしない)は、パスが**残る**ことで成立している。
    /// 送信が失敗すると穴として価値化されず、しかも**画面は何事もなく進む**ので、
    /// 本人にもこちらにも見えない。それを見えるようにする種類。
    test('パスが送れなかったことを記録する種類がある', () {
      expect(Degradation.values, contains(Degradation.passNotSent));
      expect(Degradation.passNotSent.id, 'pass_not_sent');
    });

    test('「わかった」が送れなかったことを記録する種類がある', () {
      expect(Degradation.values, contains(Degradation.understoodNotSent));
      expect(Degradation.understoodNotSent.id, 'understood_not_sent');
    });

    /// 授業が丸ごと途切れたのに、画面は祝福へ進む。**記録が無ければ、
    /// こちらから見えるのは「なぜか短いセッションがある」だけになる。**
    test('会話が途中で切れたことを記録する種類がある', () {
      expect(Degradation.values, contains(Degradation.sessionDropped));
      expect(Degradation.sessionDropped.id, 'session_dropped');
    });
  });
}
