import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart' hide SessionLimits;
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

/// 1/3/7日後の小テスト。
///
/// 採点画面ではなく本人の二択で、無料のテキストから原価のある音声へ渡す境界だけを見る。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  Future<ProviderContainer> pumpReview(
    WidgetTester tester,
    FakeReviewController review, {
    _RecordingCaptureController? capture,
  }) async {
    await setSurface(tester);
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        onboardedProvider.overrideWithValue(true),
        deviceIdProvider.overrideWithValue('dev_review_test'),
        progressControllerProvider.overrideWith(FakeProgressController.new),
        reviewControllerProvider.overrideWith(() => review),
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

  testWidgets('無料ユーザーでも問題文と二択が出て、まだペイウォールには着かない',
      (WidgetTester tester) async {
    final FakeReviewController review = FakeReviewController(
      sampleReviewQueue.copyWith(lessonRequiresPremium: true),
    );
    await pumpReview(tester, review);

    expect(find.byType(ReviewScreen), findsOneWidget);
    expect(find.text(sampleReviewQueue.items.first.quiz), findsOneWidget);
    expect(find.text(sampleReviewQueue.items.last.quiz), findsNothing, reason: '1回1問だけ出す');
    expect(find.widgetWithText(ChunkyButton, ja.reviewSaidIt), findsOneWidget);
    expect(find.widgetWithText(GhostButton, ja.reviewNotYet), findsOneWidget);
    expect(find.byType(PaywallScreen), findsNothing);
  });

  testWidgets('「言えた」は said_it を送り、次の1問へ進む', (WidgetTester tester) async {
    final ReviewQueue next = sampleReviewQueue.copyWith(
      items: <ReviewQueueItem>[sampleReviewQueue.items.last],
    );
    final FakeReviewController review = FakeReviewController(
      sampleReviewQueue,
      queueAfterAnswer: next,
    );
    await pumpReview(tester, review);

    await tester.tap(find.text(ja.reviewSaidIt));
    await tester.pumpAndSettle();

    expect(
      review.answerCalls,
      <(String, ReviewOutcome)>[
        (sampleReviewQueue.items.first.hole.id, ReviewOutcome.saidIt),
      ],
    );
    expect(find.text(next.items.single.quiz), findsOneWidget);
    expect(find.text(sampleReviewQueue.items.first.quiz), findsNothing);
  });

  testWidgets('「まだ言えない」だけではサーバへ送らず、咎める文言も出さない',
      (WidgetTester tester) async {
    // 通知文に「もう一度」が入っていても、「まだ」のあとは引き取る文だけに切り替える。
    final ReviewQueue queue = sampleReviewQueue.copyWith(
      items: <ReviewQueueItem>[sampleReviewQueue.items.last],
    );
    final FakeReviewController review = FakeReviewController(queue);
    await pumpReview(tester, review);

    await tester.tap(find.text(ja.reviewNotYet));
    await tester.pumpAndSettle();

    expect(review.answerCalls, isEmpty, reason: 'not_yet は記録しない');
    expect(find.text(ja.reviewNotYetLead), findsOneWidget);
    expect(find.widgetWithText(ChunkyButton, ja.reviewAskSenpai), findsOneWidget);
    expect(find.widgetWithText(GhostButton, ja.reviewLater), findsOneWidget);
    for (final String blaming in <String>['間違い', '不正解', '残念', 'もう一度']) {
      expect(find.textContaining(blaming), findsNothing, reason: '「まだ」を咎めない');
    }

    await tester.tap(find.text(ja.reviewLater));
    await tester.pumpAndSettle();
    expect(find.text(ja.reviewNotYet), findsOneWidget);
    expect(review.answerCalls, isEmpty);
  });

  testWidgets('Premiumは「先輩に聞く」で復習セッションを作る', (WidgetTester tester) async {
    final FakeReviewController review = FakeReviewController(
      sampleReviewQueue.copyWith(lessonRequiresPremium: false),
    );
    final _RecordingCaptureController capture = _RecordingCaptureController();
    await pumpReview(tester, review, capture: capture);

    await tester.tap(find.text(ja.reviewNotYet));
    await tester.pumpAndSettle();
    await tester.tap(find.text(ja.reviewAskSenpai));
    await tester.pumpAndSettle();

    expect(
      capture.startReviewCalls,
      <(String, String)>[(sampleReviewQueue.items.first.hole.id, 'ja')],
    );
    expect(find.byType(SessionScreen), findsOneWidget);
  });

  testWidgets('復習セッションを作れなければ、サーバの理由を画面に出す',
      (WidgetTester tester) async {
    const ApiException failure = ApiException(
      code: 'free_limit_reached',
      message: '今日はここまでにしよっか。明日また続きやろう。',
    );
    final FakeReviewController review = FakeReviewController(sampleReviewQueue);
    final _RecordingCaptureController capture = _RecordingCaptureController(failure: failure);
    await pumpReview(tester, review, capture: capture);

    await tester.tap(find.text(ja.reviewNotYet));
    await tester.pumpAndSettle();
    await tester.tap(find.text(ja.reviewAskSenpai));
    await tester.pumpAndSettle();

    expect(find.text(failure.message), findsOneWidget);
    expect(find.byType(ReviewScreen), findsOneWidget);
  });
}

/// 復習セッション作成だけを記録し、LiveKitには接続しない。
class _RecordingCaptureController extends CaptureController {
  _RecordingCaptureController({this.failure});

  final ApiException? failure;
  final List<(String, String)> startReviewCalls = <(String, String)>[];

  @override
  CaptureState build() => const CaptureState();

  @override
  Future<SessionStart?> startReview(String holeId, {String locale = 'ja'}) async {
    startReviewCalls.add((holeId, locale));
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
      detectedTopics: <DetectedTopic>[],
      limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: true),
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
  Future<void> connect(SessionStart session) async {}
}
