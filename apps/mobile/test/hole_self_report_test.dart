import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/application/lesson_hole_candidate.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/harness.dart';

final Hole relevantHole = Hole(
  id: 'hol_previous_discriminant',
  topicId: 'M1-NIJI-HANBETSU',
  description: '判別式を「なぜ」使うのか、で説明が止まった',
  severity: HoleSeverity.medium,
  status: HoleStatus.open,
  createdAt: DateTime.utc(2026, 8, 1, 12),
);

final Hole sameTopicButUnrelatedHole = Hole(
  id: 'hol_previous_formula',
  topicId: 'M1-NIJI-HANBETSU',
  description: '解の公式で符号を変えるところで説明が止まった',
  severity: HoleSeverity.high,
  status: HoleStatus.open,
  createdAt: DateTime.utc(2026, 8, 2, 12),
);

final Karte lessonKarte = sampleKarte.copyWith(
  id: 'kar_lesson',
  sessionId: 'ses_lesson',
  createdAt: DateTime.utc(2026, 8, 3, 12),
  topicIds: const <String>['M1-NIJI-HANBETSU'],
  saidWell: const <String>['判別式を使うと、二次方程式の解の個数がわかると説明できた'],
  // 今回できた穴は自己申告の候補ではない。画面テストでは通知カードも出さず、
  // 過去の穴だけに焦点を当てる。
  holes: const <Hole>[],
  termNotes: const <String>[],
);

final ReviewQueue lessonQueue = ReviewQueue(
  requiresPremium: false,
  items: <ReviewQueueItem>[
    ReviewQueueItem(
      hole: sameTopicButUnrelatedHole,
      daysSince: 1,
      prompt: '前の穴を、いまなら説明できますか?',
    ),
    ReviewQueueItem(
      hole: relevantHole,
      daysSince: 2,
      prompt: '前の穴を、いまなら説明できますか?',
    ),
  ],
);

class RecordingReviewController extends ReviewController {
  RecordingReviewController(this.initial);

  final ReviewQueue initial;
  String? filledHoleId;

  @override
  Future<ReviewQueue> build() async => initial;

  @override
  Future<void> fillHole(String holeId) async {
    filledHoleId = holeId;
    final ReviewQueue current = state.value ?? initial;
    state = AsyncValue<ReviewQueue>.data(
      current.copyWith(
        items: current.items
            .where((ReviewQueueItem item) => item.hole.id != holeId)
            .toList(growable: false),
      ),
    );
  }
}

void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  test('自己申告APIは穴IDを含むPOSTを送り、本文のない成功を受け取れる', () async {
    late http.Request sent;
    final ApiClient client = ApiClient(
      baseUrl: 'http://test',
      deviceId: 'device-1',
      client: MockClient((http.Request request) async {
        sent = request;
        return http.Response('', 204);
      }),
    );

    await client.fillHole('hol_1');

    expect(sent.method, 'POST');
    expect(sent.url.path, '/v1/me/holes/hol_1/filled');
    expect(sent.headers['x-device-id'], 'device-1');
  });

  group('授業後に聞く穴の選び方', () {
    test('topic_idだけで全件を出さず、「言えたこと」と具体語が重なる1件だけを選ぶ', () {
      final ReviewQueueItem? selected = selectLessonHoleCandidate(
        karte: lessonKarte,
        queue: lessonQueue,
      );

      expect(selected?.hole.id, relevantHole.id);
      expect(selected?.hole.id, isNot(sameTopicButUnrelatedHole.id));
    });

    test('今回できた穴と、具体語が重ならない過去の穴は出さない', () {
      final Hole currentHole = relevantHole.copyWith(
        id: 'hol_current',
        createdAt: lessonKarte.createdAt,
      );
      final Karte currentKarte = lessonKarte.copyWith(
        holes: <Hole>[currentHole],
      );
      final ReviewQueue onlyCurrent = ReviewQueue(
        requiresPremium: false,
        items: <ReviewQueueItem>[
          ReviewQueueItem(hole: currentHole, daysSince: 0, prompt: '今回の穴'),
          ReviewQueueItem(
            hole: sameTopicButUnrelatedHole,
            daysSince: 1,
            prompt: '関係しない過去の穴',
          ),
        ],
      );

      expect(
        selectLessonHoleCandidate(karte: currentKarte, queue: onlyCurrent),
        isNull,
      );
    });
  });

  group('授業後のカルテ', () {
    Future<RecordingReviewController> pumpLessonKarte(
      WidgetTester tester, {
      String kind = 'new',
      Locale locale = const Locale('ja'),
    }) async {
      final RecordingReviewController controller = RecordingReviewController(
        lessonQueue,
      );
      await pumpApp(
        tester,
        const KarteScreen(),
        locale: locale,
        overrides: <Object?>[
          latestKarteControllerProvider.overrideWith(
            () => FakeLatestKarteController(lessonKarte),
          ),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(SessionOutcome(kind: kind)),
          ),
          reviewControllerProvider.overrideWith(() => controller),
        ],
      );
      return controller;
    }

    testWidgets('関係する過去の穴だけを出し、「まだ」は何も変えず閉じる', (WidgetTester tester) async {
      final RecordingReviewController controller = await pumpLessonKarte(
        tester,
      );

      expect(find.text(ja.holeSelfReportQuestion), findsOneWidget);
      expect(find.text(relevantHole.description), findsOneWidget);
      expect(find.text(sameTopicButUnrelatedHole.description), findsNothing);
      expect(find.text(ja.holeSelfReportLater), findsOneWidget);

      await tester.tap(find.text(ja.holeSelfReportNotYet));
      await tester.pumpAndSettle();

      expect(find.text(ja.holeSelfReportQuestion), findsNothing);
      expect(controller.filledHoleId, isNull);
    });

    testWidgets('「言えるようになった」を選んだときだけ自己申告APIの操作へ渡す', (
      WidgetTester tester,
    ) async {
      final RecordingReviewController controller = await pumpLessonKarte(
        tester,
      );

      await tester.tap(find.text(ja.holeSelfReportCanSay));
      await tester.pumpAndSettle();

      expect(controller.filledHoleId, relevantHole.id);
      expect(find.text(ja.holeSelfReportQuestion), findsNothing);
    });

    testWidgets('復習セッションのカルテでは授業後の聞き直しを重ねない', (WidgetTester tester) async {
      await pumpLessonKarte(tester, kind: 'review');

      expect(find.text(ja.holeSelfReportQuestion), findsNothing);
    });

    testWidgets('英語でも本人の選択と、あとで選べることを伝える', (WidgetTester tester) async {
      const AppStrings en = AppStrings(Locale('en'));
      await pumpLessonKarte(tester, locale: const Locale('en'));

      expect(find.text(en.holeSelfReportQuestion), findsOneWidget);
      expect(find.text(en.holeSelfReportCanSay), findsOneWidget);
      expect(find.text(en.holeSelfReportNotYet), findsOneWidget);
      expect(find.text(en.holeSelfReportLater), findsOneWidget);
    });
  });

  group('復習画面', () {
    Future<RecordingReviewController> pumpReview(WidgetTester tester) async {
      final RecordingReviewController controller = RecordingReviewController(
        ReviewQueue(
          requiresPremium: false,
          items: <ReviewQueueItem>[
            ReviewQueueItem(
              hole: relevantHole,
              daysSince: 2,
              prompt: 'いまなら言える?',
            ),
          ],
        ),
      );
      await pumpApp(
        tester,
        const ReviewScreen(),
        overrides: <Object?>[
          reviewControllerProvider.overrideWith(() => controller),
        ],
      );
      return controller;
    }

    testWidgets('音声セッションの前に自己申告を聞き、「まだ」はopenのまま閉じる', (
      WidgetTester tester,
    ) async {
      final RecordingReviewController controller = await pumpReview(tester);

      await tester.tap(find.text(ja.reviewStart));
      await tester.pumpAndSettle();
      expect(find.text(ja.holeSelfReportQuestion), findsOneWidget);
      expect(find.text(ja.holeSelfReportReviewWithSenpai), findsOneWidget);

      await tester.tap(find.text(ja.holeSelfReportNotYet));
      await tester.pumpAndSettle();

      expect(controller.filledHoleId, isNull);
      expect(find.text(relevantHole.description), findsOneWidget);
    });

    testWidgets('声を出さずに「言える」を選ぶと、その穴だけを埋める', (WidgetTester tester) async {
      final RecordingReviewController controller = await pumpReview(tester);

      await tester.tap(find.text(ja.reviewStart));
      await tester.pumpAndSettle();
      await tester.tap(find.text(ja.holeSelfReportCanSay));
      await tester.pumpAndSettle();

      expect(controller.filledHoleId, relevantHole.id);
      expect(find.text(ja.reviewEmpty), findsOneWidget);
    });
  });
}
