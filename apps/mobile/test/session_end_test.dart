import 'dart:async';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart'
    as karte
    show ProgressSummary, SessionLimits;
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// 会話の終わり(「わかった」または離脱 → 終了画面)のテスト。
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
        Color.alphaBlend(
          AppColors.streak.withValues(alpha: 0.08),
          AppColors.background,
        ),
      );
      // テーマの地も同様(こちらは元から不透明)。
      expect(AppTheme.light().scaffoldBackgroundColor.a, 1.0);
    });
  });

  /// 復習問題の生成完了を待たず、降り方だけで終了画面を確定する。
  /// この画面は `go()` で来るので、押せる出口が無い状態を作ると行き止まりになる。
  group('終了画面', () {
    Future<void> pumpEnding(
      WidgetTester tester,
      SessionEnding ending, {
      bool showPaywall = false,
    }) => pumpApp(
      tester,
      const CelebrationScreen(),
      overrides: <Object?>[
        progressControllerProvider.overrideWith(FakeProgressController.new),
        sessionOutcomeControllerProvider.overrideWith(
          () => FakeSessionOutcomeController(
            SessionOutcome(ending: ending, showPaywall: showPaywall),
          ),
        ),
      ],
    );

    testWidgets('「わかった」は生成を待たず、3日後の問題と2つの出口を出す', (WidgetTester tester) async {
      await pumpEnding(tester, SessionEnding.understood);

      expect(find.text(ja.celebrationTitle), findsOneWidget);
      expect(find.text(ja.celebrationPracticeTitle), findsOneWidget);
      expect(find.text(ja.celebrationPracticeBody), findsOneWidget);
      expect(
        find.byKey(const Key('celebration-another-lesson')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('celebration-done')), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('時間切れは祝福せず、問題を作らない理由とホームへの出口を出す', (WidgetTester tester) async {
      await pumpEnding(tester, SessionEnding.timeLimit);

      expect(find.text(ja.timeLimitTitle), findsOneWidget);
      expect(find.text(ja.timeLimitBody), findsOneWidget);
      expect(find.text(ja.timeLimitCardTitle), findsOneWidget);
      expect(find.text(ja.timeLimitCardBody), findsOneWidget);
      expect(find.text(ja.celebrationPracticeTitle), findsNothing);
      expect(find.byKey(const Key('time-limit-home')), findsOneWidget);
    });

    /// 今日の枠が無い人に「もう1問」を出すと、押した先の撮影で写真まで
    /// 撮らせてから、サーバが「今日はここまで」と断ることになる。
    testWidgets('使い切った回は「もう1問」を Premium への道に差し替える', (
      WidgetTester tester,
    ) async {
      await pumpEnding(tester, SessionEnding.understood, showPaywall: true);

      expect(find.byKey(const Key('celebration-see-premium')), findsOneWidget);
      expect(find.text(ja.paywallCta), findsOneWidget);
      expect(find.byKey(const Key('celebration-another-lesson')), findsNothing);
      // ホームへ降りる出口は残す(行き止まりにしない)。
      expect(find.byKey(const Key('celebration-done')), findsOneWidget);
    });

    // 枠が残っている回に売り込まない(§6 煽らない)。
    testWidgets('枠が残っている回は、いつもの2つの出口のまま', (WidgetTester tester) async {
      await pumpEnding(tester, SessionEnding.understood);

      expect(find.byKey(const Key('celebration-another-lesson')), findsOneWidget);
      expect(find.byKey(const Key('celebration-see-premium')), findsNothing);
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

    testWidgets('時間切れの会話画面は、残り1秒で止めず終了処理を明示する', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const SessionScreen(),
        overrides: <Object?>[
          captureControllerProvider.overrideWith(FakeCaptureController.new),
          sessionControllerProvider.overrideWith(
            () => FakeSessionController(
              const SessionState(
                phase: SessionPhase.summarizing,
                remainingSeconds: 0,
              ),
            ),
          ),
        ],
      );

      expect(find.text(ja.sessionSummarizing), findsWidgets);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text(ja.remaining(1)), findsNothing);
    });
  });

  /// 終了画面を出すことと、結果・残高をあとから合わせることは別々の仕事。
  ///
  /// 結果がまだ届かないときも、`/start` の仮押さえを表示したままにせず、
  /// 画面は先に終え、サーバで確定した残高だけを裏で取り直す。
  test('結果の再確認を待たずに画面を終え、残高はあとから更新する', () async {
    const karte.ProgressSummary reserved = karte.ProgressSummary(
      progress: sampleProgress,
      isPremium: false,
      limits: karte.SessionLimits(
        maxSeconds: 1200,
        remainingSecondsToday: 0,
        lessonAllowedToday: false,
      ),
    );
    const karte.ProgressSummary settled = karte.ProgressSummary(
      progress: sampleProgress,
      isPremium: false,
      limits: karte.SessionLimits(
        maxSeconds: 1200,
        remainingSecondsToday: 900,
        lessonAllowedToday: true,
      ),
    );
    final _MissingResultApiClient api = _MissingResultApiClient();
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        apiClientProvider.overrideWithValue(api),
        progressControllerProvider.overrideWith(
          () => _ReservedProgressController(reserved),
        ),
        sessionControllerProvider.overrideWith(
          _CompletingSessionController.new,
        ),
      ].cast(),
    );
    addTearDown(container.dispose);
    final ProviderSubscription<SessionState> subscription = container.listen(
      sessionControllerProvider,
      (_, _) {},
    );
    addTearDown(subscription.close);

    await container.read(progressControllerProvider.future);
    final Future<void> finishing = container
        .read(sessionControllerProvider.notifier)
        .finish(ending: SessionEnding.understood);
    await finishing;
    await api.progressRequested.future;

    expect(api.resultAttempts, 8, reason: '結果の再確認は画面遷移のあとでだけ続ける');
    expect(api.resultInterval, const Duration(seconds: 1));
    expect(
      container.read(sessionControllerProvider).phase,
      SessionPhase.finished,
    );
    expect(
      container.read(sessionOutcomeControllerProvider).ending,
      SessionEnding.understood,
    );
    // 再取得が返る前も loading へ落とさず、直前の数字を残す。
    expect(
      container
          .read(progressControllerProvider)
          .value
          ?.limits
          .remainingSecondsToday,
      0,
    );

    api.progress.complete(settled);
    await Future<void>.delayed(Duration.zero);

    expect(api.progressCalls, 1);
    expect(
      container
          .read(progressControllerProvider)
          .value
          ?.limits
          .remainingSecondsToday,
      900,
    );
    expect(
      container
          .read(progressControllerProvider)
          .value
          ?.limits
          .lessonAllowedToday,
      isTrue,
    );
  });

  group('授業画面の降り方', () {
    Future<FakeSessionController> pumpSession(
      WidgetTester tester,
      SessionPhase phase,
    ) async {
      await pumpApp(
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
      final ProviderContainer container = ProviderScope.containerOf(
        tester.element(find.byType(SessionScreen)),
        listen: false,
      );
      return container.read(sessionControllerProvider.notifier)
          as FakeSessionController;
    }

    bool understoodButtonEnabled(WidgetTester tester) {
      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      return button.onPressed != null;
    }

    testWidgets('会話中は「わかった」と左上の × を出す', (WidgetTester tester) async {
      await pumpSession(tester, SessionPhase.listening);
      expect(find.text(ja.sessionUnderstood), findsOneWidget);
      expect(understoodButtonEnabled(tester), isTrue);
      expect(find.byKey(const Key('session-close')), findsOneWidget);
      expect(find.text(ja.sessionEnd), findsNothing);
      expect(find.text(ja.sessionPass), findsNothing);
    });

    testWidgets('終了処理に入ったあとは「わかった」を押せなくする', (WidgetTester tester) async {
      await pumpSession(tester, SessionPhase.summarizing);

      expect(find.text(ja.sessionUnderstood), findsOneWidget);
      expect(find.text(ja.sessionSummarizing), findsWidgets);
      expect(understoodButtonEnabled(tester), isFalse);

      // 待たせている場所を出す。
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('×から「やめる」を選ぶと、離脱理由を付けて finish() に合流する', (
      WidgetTester tester,
    ) async {
      final FakeSessionController controller = await pumpSession(
        tester,
        SessionPhase.senpaiTeaching,
      );

      await tester.tap(find.byKey(const Key('session-close')));
      await tester.pumpAndSettle();
      expect(find.text(ja.sessionQuitTitle), findsOneWidget);

      await tester.tap(find.widgetWithText(GhostButton, ja.sessionQuit));
      await tester.pumpAndSettle();

      expect(controller.finishCalls, 1);
      expect(controller.lastEnding, SessionEnding.other);
      expect(find.text(ja.sessionQuitTitle), findsNothing);
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
      livekit: LiveKitConnection(
        url: 'wss://example',
        token: 't',
        room: 'ses_1',
      ),
      limits: SessionLimits(
        maxSeconds: 1200,
        remainingSecondsToday: 1200,
        lessonAllowedToday: true,
      ),
    ),
  );
}

/// 状態を固定して画面だけを見る。LiveKitにはつなぎに行かせない。
class FakeSessionController extends SessionController {
  FakeSessionController(this._state);

  final SessionState _state;
  int finishCalls = 0;
  SessionEnding? lastEnding;

  @override
  SessionState build() => _state;

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}

  @override
  Future<void> finish({SessionEnding? ending}) async {
    finishCalls += 1;
    lastEnding = ending;
  }
}

/// LiveKitを立てず、先輩と話したあとの終了処理だけを本物の `finish()` へ通す。
class _CompletingSessionController extends SessionController {
  @override
  SessionState build() =>
      const SessionState(phase: SessionPhase.listening, remainingSeconds: 300);

  @override
  bool get sessionHadConversation => true;

  @override
  String? get activeSessionId => 'ses_1';
}

class _ReservedProgressController extends ProgressController {
  _ReservedProgressController(this._reserved);

  final karte.ProgressSummary _reserved;

  @override
  Future<karte.ProgressSummary> build() async => _reserved;
}

/// 結果は未着のまま、残高の再取得だけを任意の時点で返すAPI。
class _MissingResultApiClient extends ApiClient {
  _MissingResultApiClient()
    : super(baseUrl: 'http://test', deviceId: 'device-session-end');

  final Completer<void> progressRequested = Completer<void>();
  final Completer<karte.ProgressSummary> progress =
      Completer<karte.ProgressSummary>();
  int progressCalls = 0;
  int? resultAttempts;
  Duration? resultInterval;

  @override
  Future<SessionResult?> awaitSessionResult(
    String sessionId, {
    Duration interval = const Duration(seconds: 2),
    int attempts = 5,
  }) async {
    resultAttempts = attempts;
    resultInterval = interval;
    return null;
  }

  @override
  Future<karte.ProgressSummary> fetchProgress() {
    progressCalls += 1;
    if (!progressRequested.isCompleted) progressRequested.complete();
    return progress.future;
  }
}
