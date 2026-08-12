import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/common_widgets/confetti.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// 会話の終わり(「今日はここまで」→ 祝福 → カルテ)のテスト。
///
/// ここに並べてあるのは、実機のユーザーテストで出た3つの報告のうち
/// アプリ側の2つ:
///   - 最後の画面が黒くなって固まる
///   - 「今日はここまで」を押しても反応しないので連打してしまう
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  /// 画面の地は**不透明**でなければならない。
  ///
  /// 半透明の色を `Scaffold.backgroundColor` に渡すと、遷移が終わって
  /// 下のルートがツリーから外れた瞬間、透けた先には何も無くなる
  /// (端末の地の色 = 黒)。本文は ink(ほぼ黒)なので黒に沈み、
  /// 画面全体が真っ黒で固まったように見える。
  ///
  /// 祝福画面は `go()` で来る = 下に何も積まない画面なので、ここを
  /// 半透明に戻すと必ず黒くなる。
  group('画面の地', () {
    testWidgets('祝福画面の地は不透明', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const CelebrationScreen(),
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(const SessionOutcome()),
          ),
        ],
      );

      final Scaffold scaffold = tester.widget(find.byType(Scaffold));
      expect(scaffold.backgroundColor, isNotNull);
      expect(scaffold.backgroundColor!.a, 1.0);
    });

    test('トークンの祝福色そのものが不透明', () {
      expect(AppColors.celebration.a, 1.0);
      // 敷きたかったのは色であって透明度。見た目は据え置きであること。
      expect(
        AppColors.celebration,
        Color.alphaBlend(AppColors.streak.withValues(alpha: 0.08), AppColors.background),
      );
      // テーマの地も同様(こちらは元から不透明)。
      expect(AppTheme.light().scaffoldBackgroundColor.a, 1.0);
    });
  });

  /// カルテを待っている祝福画面には、必ず出口がある。
  ///
  /// この画面は `go()` で来るので戻る先が無い。カルテが届くまで
  /// 押せるものが1つも無いと、待つ以外にできることがない行き止まりになる。
  group('祝福画面', () {
    Future<void> pumpWaiting(WidgetTester tester) => pumpApp(
          tester,
          const CelebrationScreen(),
          overrides: <Object?>[
            progressControllerProvider.overrideWith(FakeProgressController.new),
            latestKarteControllerProvider.overrideWith(EmptyLatestKarteController.new),
            sessionOutcomeControllerProvider.overrideWith(
              () => FakeSessionOutcomeController(
                const SessionOutcome(resultMissing: true, sessionId: 'ses_1'),
              ),
            ),
          ],
        );

    testWidgets('カルテが届いていれば、カルテへ進むボタンを出す', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const CelebrationScreen(),
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(const SessionOutcome()),
          ),
        ],
      );

      expect(find.text(ja.karteTitle), findsOneWidget);
      // 届いているのに「ホームにもどる」を出すと、逃げ道のほうが目立つ。
      expect(find.text(ja.sessionBackHome), findsNothing);
    });

    testWidgets('カルテを待っているあいだも行き止まりにしない', (WidgetTester tester) async {
      await pumpWaiting(tester);
      expect(find.text(ja.sessionBackHome), findsOneWidget);
    });

    /// 待っているあいだ、**押せないボタン以外のもの**を出す。
    ///
    /// 文言の変わらない無効なボタンだけが置いてあると、待っているのか
    /// 壊れたのかが読めない。何を待っているのかを言葉で出す。
    testWidgets('カルテを待っているあいだ、何を待っているのかを出す', (WidgetTester tester) async {
      await pumpWaiting(tester);

      expect(find.text(ja.karteWriting), findsOneWidget);
      expect(find.text(ja.karteRetrieving), findsOneWidget);
      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      expect(button.onPressed, isNull);
    });

    /// 待たせる画面から**動きを消さない**。
    ///
    /// 紙吹雪は一度きりだと2秒で止まる。そのあとカルテを待つ数十秒は
    /// 画面がまったく動かなくなり、固まったようにしか見えない。
    testWidgets('カルテを待っているあいだ、紙吹雪は降り続ける', (WidgetTester tester) async {
      await pumpWaiting(tester);

      final ConfettiBurst confetti = tester.widget(find.byType(ConfettiBurst));
      expect(confetti.looping, isTrue);
    });

    testWidgets('カルテが届いていれば、紙吹雪は一度きりで終わる', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const CelebrationScreen(),
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(const SessionOutcome()),
          ),
        ],
      );

      final ConfettiBurst confetti = tester.widget(find.byType(ConfettiBurst));
      expect(confetti.looping, isFalse);
    });
  });

  /// 残り時間は**0まで見せる**。
  ///
  /// 0を飛ばして打ち切ると、時間切れで終わった会話が「のこり 0:01」の
  /// まま止まる。まだ1秒あるのに動かない画面は、固まったようにしか見えない。
  group('残り時間', () {
    test('0秒は 0:00 と出る', () {
      expect(ja.remaining(0), 'のこり 0:00');
      expect(const AppStrings(Locale('en')).remaining(0), '0:00 left');
    });

    testWidgets('時間切れの会話画面は 0:00 を出す', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const SessionScreen(),
        overrides: <Object?>[
          captureControllerProvider.overrideWith(FakeCaptureController.new),
          sessionControllerProvider.overrideWith(
            () => FakeSessionController(
              const SessionState(phase: SessionPhase.summarizing, remainingSeconds: 0),
            ),
          ),
        ],
      );

      expect(find.text(ja.remaining(0)), findsOneWidget);
    });
  });

  /// 「今日はここまで」は、**押した瞬間に**押せなくなること。
  ///
  /// 以前は `finish()` が先に片付け(切断の完了待ち)をしてから状態を変えて
  /// いたため、押しても数秒間、画面が押す前とまったく同じままだった。
  /// 反応が無いので連打される。
  group('会話画面の「今日はここまで」', () {
    Future<void> pumpSession(WidgetTester tester, SessionPhase phase) => pumpApp(
          tester,
          const SessionScreen(),
          overrides: <Object?>[
            captureControllerProvider.overrideWith(FakeCaptureController.new),
            sessionControllerProvider.overrideWith(
              () => FakeSessionController(
                SessionState(phase: phase, remainingSeconds: 120),
              ),
            ),
          ],
        );

    bool endButtonEnabled(WidgetTester tester) {
      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      return button.onPressed != null;
    }

    testWidgets('会話中は押せる', (WidgetTester tester) async {
      await pumpSession(tester, SessionPhase.listening);
      expect(find.text(ja.sessionEnd), findsOneWidget);
      expect(endButtonEnabled(tester), isTrue);
      // まだ聞いているので「うまく言えない」も押せる。
      expect(find.widgetWithText(GhostButton, ja.sessionPass), findsOneWidget);
      final GhostButton pass = tester.widget(find.byType(GhostButton));
      expect(pass.onPressed, isNotNull);
    });

    testWidgets('押したあとは押せなくなり、何をしているかを出す', (WidgetTester tester) async {
      await pumpSession(tester, SessionPhase.summarizing);

      // 文言が変わる = 受け取ってあることが読んで分かる。
      expect(find.text(ja.sessionEnd), findsNothing);
      expect(find.text(ja.sessionSummarizing), findsWidgets);
      expect(endButtonEnabled(tester), isFalse);

      // 会話は終わっているので、パスも押させない。
      final GhostButton pass = tester.widget(find.byType(GhostButton));
      expect(pass.onPressed, isNull);

      // 待たせている場所を出す。
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });
  });
}

/// 会話画面が「セッションはある」と読めるようにするだけの差し替え。
class FakeCaptureController extends CaptureController {
  @override
  CaptureState build() => const CaptureState(
        analysis: SessionAnalysis(
          sessionId: 'ses_1',
          kind: 'new',
          detectedTopics: <DetectedTopic>[],
        ),
        session: SessionStart(
          sessionId: 'ses_1',
          kind: 'new',
          livekit: LiveKitConnection(url: 'wss://example', token: 't', room: 'ses_1'),
          limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: true),
        ),
      );
}

/// 状態を固定して画面だけを見る。LiveKitにはつなぎに行かせない。
class FakeSessionController extends SessionController {
  FakeSessionController(this._state);

  final SessionState _state;

  @override
  SessionState build() => _state;

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}
}
