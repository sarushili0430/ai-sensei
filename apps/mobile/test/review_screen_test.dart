import 'dart:async';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart'
    hide SessionLimits;
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/routing/routes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// 通知から開く復習問題。
///
/// テキスト解答は無料、AI採点の結果が不正解か判定不能のときだけ、
/// 原価のある音声授業へ渡す境界を見る。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  Future<ProviderContainer> pumpReview(
    WidgetTester tester, {
    PracticeQueue? queue,
    _RecordingPracticeAnswerController? answers,
    _RecordingCaptureController? capture,
    ProgressSummary progress = sampleSummary,
  }) async {
    await setSurface(tester);
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        onboardedProvider.overrideWithValue(true),
        deviceIdProvider.overrideWithValue('dev_review_test'),
        progressControllerProvider.overrideWith(
          () => FakeProgressController(progress),
        ),
        reviewControllerProvider.overrideWith(
          () => FakeReviewController(queue ?? samplePracticeQueue),
        ),
        practiceAnswerControllerProvider.overrideWith(
          () => answers ?? _RecordingPracticeAnswerController(),
        ),
        if (capture != null)
          captureControllerProvider.overrideWith(() => capture),
        sessionControllerProvider.overrideWith(_FakeSessionController.new),
      ].cast(),
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(wrapRouter(container));
    await tester.pumpAndSettle();
    container.read(appRouterProvider).go(AppRoute.review.path);
    await tester.pumpAndSettle();
    return container;
  }

  Future<void> answer(WidgetTester tester, String response) async {
    await tester.enterText(
      find.byKey(const Key('practice-response')),
      response,
    );
    // 入力欄のlistenerが送信ボタンを有効にした次のフレームで押す。
    // 同じフレームのまま押すと、無効だったボタンを叩いて何も起きない。
    await tester.pump();
    await tester.tap(find.byKey(const Key('practice-submit')));
    await tester.pumpAndSettle();
  }

  testWidgets('無料ユーザーでも先頭の1問とテキスト入力を出し、自己申告の二択は出さない', (
    WidgetTester tester,
  ) async {
    await pumpReview(tester);

    expect(find.byType(ReviewScreen), findsOneWidget);
    expect(find.text(samplePracticeProblem.question), findsOneWidget);
    expect(find.text(sampleSecondPracticeProblem.question), findsNothing);
    expect(find.byKey(const Key('practice-response')), findsOneWidget);
    expect(find.byKey(const Key('practice-submit')), findsOneWidget);
    expect(
      tester
          .widget<ChunkyButton>(find.byKey(const Key('practice-submit')))
          .onPressed,
      isNull,
    );
    expect(find.text(ja.reviewSaidIt), findsNothing);
    expect(find.text(ja.reviewNotYet), findsNothing);
    expect(find.byType(PaywallScreen), findsNothing);
  });

  testWidgets('解答を送ると採点中を明示し、正解なら本人の文と3・7日後の予定を残す', (
    WidgetTester tester,
  ) async {
    final Completer<void> release = Completer<void>();
    final _RecordingPracticeAnswerController answers =
        _RecordingPracticeAnswerController(release: release);
    await pumpReview(tester, answers: answers);

    await tester.enterText(
      find.byKey(const Key('practice-response')),
      'D = 16 で D > 0 だから2個',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('practice-submit')));
    await tester.pump();

    expect(answers.submitCalls, <String>[samplePracticeProblem.id]);
    expect(find.text(ja.practiceGrading), findsOneWidget);
    expect(find.text(ja.practiceGradingCanClose), findsOneWidget);
    expect(find.text('D = 16 で D > 0 だから2個'), findsOneWidget);

    release.complete();
    await tester.pumpAndSettle();

    expect(find.text(ja.practiceCorrect), findsOneWidget);
    expect(find.text('D = 16 で D > 0 だから2個'), findsOneWidget);
    expect(find.text(ja.practiceNextSchedule(<int>[3, 7])), findsOneWidget);
    expect(find.byKey(const Key('practice-home')), findsOneWidget);
  });

  testWidgets('不正解は本人を咎めず、1・3・7日後の予定と聞き直す道を出す', (WidgetTester tester) async {
    final _RecordingPracticeAnswerController answers =
        _RecordingPracticeAnswerController(verdict: PracticeVerdict.incorrect);
    await pumpReview(tester, answers: answers);
    await answer(tester, 'D = 16 だから1個');

    expect(find.text(ja.practiceIncorrect), findsOneWidget);
    expect(find.text(ja.practiceNextSchedule(<int>[1, 3, 7])), findsOneWidget);
    expect(find.text(ja.reviewAskSenpai), findsOneWidget);
    expect(find.text(ja.reviewLater), findsOneWidget);
    for (final String blaming in <String>['残念', '失敗', 'あなたのせい']) {
      expect(
        find.textContaining(blaming),
        findsNothing,
        reason: '採点結果で本人を咎めない',
      );
    }

    await tester.tap(find.text(ja.reviewAskSenpai));
    await tester.pumpAndSettle();
    expect(find.text(ja.reviewVoicePremium), findsOneWidget);
    expect(find.text(ja.homeUnlock), findsOneWidget);

    await tester.tap(find.text(ja.homeUnlock));
    await tester.pumpAndSettle();
    expect(find.byType(PaywallScreen), findsOneWidget);
  });

  testWidgets('判定不能は不正解に倒さず、通知を進めず同じ解答を直せる', (WidgetTester tester) async {
    final _RecordingPracticeAnswerController answers =
        _RecordingPracticeAnswerController(verdict: PracticeVerdict.unclear);
    await pumpReview(tester, answers: answers);
    await answer(tester, 'Dはたぶん16');

    expect(find.text(ja.practiceUnclear), findsOneWidget);
    expect(find.text(ja.practiceScheduleUnclear), findsOneWidget);
    expect(find.text(ja.practiceIncorrect), findsNothing);
    expect(find.text(ja.practiceRetry), findsOneWidget);

    await tester.tap(find.text(ja.practiceRetry));
    await tester.pumpAndSettle();

    final TextField field = tester.widget(
      find.byKey(const Key('practice-response')),
    );
    expect(field.controller?.text, 'Dはたぶん16');
  });

  testWidgets('Premiumで枠が残っていれば、問題IDから復習セッションを作る', (WidgetTester tester) async {
    final _RecordingCaptureController capture = _RecordingCaptureController();
    await pumpReview(
      tester,
      answers: _RecordingPracticeAnswerController(
        verdict: PracticeVerdict.incorrect,
      ),
      capture: capture,
      progress: premiumSummary,
    );
    await answer(tester, 'D = 16 だから1個');

    await tester.tap(find.text(ja.reviewAskSenpai));
    await tester.pumpAndSettle();

    expect(capture.startReviewCalls, <(String, String)>[
      (samplePracticeProblem.id, 'ja'),
    ]);
    expect(find.byType(SessionScreen), findsOneWidget);
  });

  testWidgets('Premiumのフェアユース上限では、課金導線を重ねず締めの文言だけを出す', (
    WidgetTester tester,
  ) async {
    await pumpReview(
      tester,
      answers: _RecordingPracticeAnswerController(
        verdict: PracticeVerdict.incorrect,
      ),
      progress: premiumExhaustedSummary,
    );
    await answer(tester, 'D = 16 だから1個');

    await tester.tap(find.text(ja.reviewAskSenpai));
    await tester.pumpAndSettle();

    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    expect(find.text(ja.homeUnlock), findsNothing);
    expect(find.byType(PaywallScreen), findsNothing);
  });

  testWidgets('開始直前に契約状態が変わっても、サーバ文言を重ねずPremium導線へ戻す', (
    WidgetTester tester,
  ) async {
    const String serverMessage = 'この機能はPremiumです。';
    final _RecordingCaptureController capture = _RecordingCaptureController(
      failure: const ApiException(
        code: 'premium_required',
        message: serverMessage,
      ),
    );
    await pumpReview(
      tester,
      answers: _RecordingPracticeAnswerController(
        verdict: PracticeVerdict.incorrect,
      ),
      capture: capture,
      progress: premiumSummary,
    );
    await answer(tester, 'D = 16 だから1個');

    await tester.tap(find.text(ja.reviewAskSenpai));
    await tester.pumpAndSettle();

    expect(find.text(ja.reviewVoicePremium), findsOneWidget);
    expect(find.text(serverMessage), findsNothing);
    expect(find.text(ja.homeUnlock), findsOneWidget);
    expect(find.byType(ReviewScreen), findsOneWidget);
  });

  testWidgets('解く問題が無くても、正解した履歴とホームへの出口を残す', (WidgetTester tester) async {
    await pumpReview(
      tester,
      queue: PracticeQueue(
        items: const <PracticeQueueItem>[],
        solved: <SolvedPractice>[sampleSolvedPractice],
      ),
    );

    expect(find.text(ja.reviewEmpty), findsOneWidget);
    expect(find.text(ja.practiceSolvedTitle(1)), findsOneWidget);
    expect(find.text(sampleSolvedPractice.problem.question), findsOneWidget);
    expect(find.text(ja.reviewBackHome), findsOneWidget);
  });
}

/// 採点の3分岐を画面へ返し、外部の採点サービスには接続しない。
class _RecordingPracticeAnswerController extends PracticeAnswerController {
  _RecordingPracticeAnswerController({
    this.verdict = PracticeVerdict.correct,
    this.release,
  });

  final PracticeVerdict verdict;
  final Completer<void>? release;
  final List<String> submitCalls = <String>[];

  @override
  PracticeAnswersState build() => const PracticeAnswersState();

  @override
  Future<bool> submit(String problemId) async {
    final String response = state.draftFor(problemId).trim();
    if (response.isEmpty || state.isGrading(problemId)) return false;
    submitCalls.add(problemId);
    state = PracticeAnswersState(
      drafts: state.drafts,
      grading: <String>{problemId},
    );

    final Completer<void>? pending = release;
    if (pending != null) await pending.future;

    final List<int> days = switch (verdict) {
      PracticeVerdict.correct => <int>[3, 7],
      PracticeVerdict.incorrect => <int>[1, 3, 7],
      PracticeVerdict.unclear => <int>[],
    };
    final PracticeAnswer answer = PracticeAnswer(
      attempt: PracticeAttempt(
        id: 'att_$problemId',
        problemId: problemId,
        answeredAt: DateTime.utc(2026, 8, 6, 11, 3, 27),
        response: response,
        verdict: verdict,
        gradedBy: 'test-grader',
        comment: verdict == PracticeVerdict.incorrect
            ? '判別式の符号と解の個数を、もう一度いっしょに見よう。'
            : null,
      ),
      nextSchedule: <PracticeScheduleEntry>[
        for (final (int index, int day) in days.indexed)
          PracticeScheduleEntry(
            problemId: problemId,
            step: index + 1,
            days: day,
            scheduledAt: DateTime.utc(2026, 8, 6 + day, 11),
          ),
      ],
      progress: sampleProgress,
    );
    state = PracticeAnswersState(
      drafts: <String, String>{...state.drafts, problemId: response},
      answers: <String, PracticeAnswer>{problemId: answer},
    );
    return true;
  }
}

/// 復習セッション作成だけを記録し、LiveKitには接続しない。
class _RecordingCaptureController extends CaptureController {
  _RecordingCaptureController({this.failure});

  final ApiException? failure;
  final List<(String, String)> startReviewCalls = <(String, String)>[];

  @override
  CaptureState build() => const CaptureState();

  @override
  Future<SessionStart?> startReview(
    String problemId, {
    String locale = 'ja',
  }) async {
    startReviewCalls.add((problemId, locale));
    final ApiException? error = failure;
    if (error != null) {
      state = CaptureState(error: error);
      return null;
    }

    const SessionStart session = SessionStart(
      sessionId: 'ses_review',
      kind: 'review',
      livekit: LiveKitConnection(
        url: 'wss://example.test',
        token: 'token',
        room: 'ses_review',
      ),
      limits: SessionLimits(
        maxSeconds: 1200,
        remainingSecondsToday: 1200,
        lessonAllowedToday: true,
      ),
    );
    state = const CaptureState(session: session);
    return session;
  }
}

/// セッション画面への遷移だけを見たいので、LiveKit接続を止める。
class _FakeSessionController extends SessionController {
  @override
  SessionState build() => const SessionState(
    phase: SessionPhase.connecting,
    remainingSeconds: 1200,
  );

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}
}
