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

/// The end of a conversation ("done for today" -> celebration -> karte).
///
/// These cover the two app-side issues of the three raised in on-device user
/// testing:
///   - the last screen turns black and appears frozen
///   - "done for today" gives no response, so people tap it repeatedly
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  /// Screen backgrounds must be opaque.
  ///
  /// Passing a translucent color to `Scaffold.backgroundColor` leaves nothing
  /// behind it once the transition ends and the route underneath leaves the tree
  /// (the device background, i.e. black). Body text is ink (nearly black) and
  /// sinks into it, so the whole screen looks black and frozen.
  ///
  /// The celebration screen arrives via `go()` with nothing stacked underneath,
  /// so making this translucent again always turns it black.
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
      // The intent was the tint, not transparency; the look is unchanged.
      expect(
        AppColors.celebration,
        Color.alphaBlend(AppColors.streak.withValues(alpha: 0.08), AppColors.background),
      );
      // The theme's background too (already opaque).
      expect(AppTheme.light().scaffoldBackgroundColor.a, 1.0);
    });
  });

  /// The celebration screen waiting on the karte always has an exit.
  ///
  /// It arrives via `go()`, so there is nothing to go back to. With nothing
  /// tappable until the karte lands, it would be a dead end.
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
      // Showing "back home" once it has arrived makes the exit the loudest thing
      // on screen.
      expect(find.text(ja.sessionBackHome), findsNothing);
    });

    testWidgets('カルテを待っているあいだも行き止まりにしない', (WidgetTester tester) async {
      await pumpWaiting(tester);
      expect(find.text(ja.sessionBackHome), findsOneWidget);
    });

    /// While waiting, show something other than a disabled button.
    ///
    /// A disabled button with unchanging wording gives no way to tell waiting
    /// from broken, so what is being waited for is said in words.
    testWidgets('カルテを待っているあいだ、何を待っているのかを出す', (WidgetTester tester) async {
      await pumpWaiting(tester);

      expect(find.text(ja.karteWriting), findsOneWidget);
      expect(find.text(ja.karteRetrieving), findsOneWidget);
      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      expect(button.onPressed, isNull);
    });

    /// A waiting screen never goes still.
    ///
    /// A one-shot burst stops after two seconds, and the tens of seconds spent
    /// waiting on the karte then look frozen.
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

  /// The countdown is shown all the way to 0.
  ///
  /// Cutting off before 0 freezes a timed-out conversation at "0:01 left", and a
  /// still screen with a second apparently remaining reads as frozen.
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

  /// "Done for today" must disable the moment it is tapped.
  ///
  /// `finish()` used to tear down (waiting on the disconnect) before changing
  /// state, leaving the screen identical for seconds after the tap. With no
  /// feedback, people tap repeatedly.
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
      // Still listening, so "I can't explain it" is tappable too.
      expect(find.widgetWithText(GhostButton, ja.sessionPass), findsOneWidget);
      final GhostButton pass = tester.widget(find.byType(GhostButton));
      expect(pass.onPressed, isNotNull);
    });

    testWidgets('押したあとは押せなくなり、何をしているかを出す', (WidgetTester tester) async {
      await pumpSession(tester, SessionPhase.summarizing);

      // The wording changes, so it reads as received.
      expect(find.text(ja.sessionEnd), findsNothing);
      expect(find.text(ja.sessionSummarizing), findsWidgets);
      expect(endButtonEnabled(tester), isFalse);

      // The conversation is over, so passing is disabled too.
      final GhostButton pass = tester.widget(find.byType(GhostButton));
      expect(pass.onPressed, isNull);

      // Show where the wait is.
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });
  });
}

/// A stand-in that only lets the conversation screen see a session.
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

/// Pins state to inspect the screen alone; it never connects LiveKit.
class FakeSessionController extends SessionController {
  FakeSessionController(this._state);

  final SessionState _state;

  @override
  SessionState build() => _state;

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}
}
