import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/application/lesson_hole_candidate.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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
  // Gaps created this time are not self-report candidates. These screen tests
  // show no notification card and focus on past gaps only.
  holes: const <Hole>[],
  termNotes: const <String>[],
);

final ReviewQueue lessonQueue = ReviewQueue(
  items: <ReviewQueueItem>[
    ReviewQueueItem(
      hole: sameTopicButUnrelatedHole,
      daysSince: 1,
      prompt: '前の穴を、いまなら説明できますか?',
      quiz: '解の公式で符号を変える理由を言える?',
    ),
    ReviewQueueItem(
      hole: relevantHole,
      daysSince: 2,
      prompt: '前の穴を、いまなら説明できますか?',
      quiz: '判別式を使う理由を言える?',
    ),
  ],
);

class RecordingReviewController extends ReviewController {
  RecordingReviewController(this.initial);

  final ReviewQueue initial;
  String? answeredHoleId;
  ReviewOutcome? answeredOutcome;

  @override
  Future<ReviewQueue> build() async => initial;

  @override
  Future<bool> answer(String holeId, ReviewOutcome outcome) async {
    answeredHoleId = holeId;
    answeredOutcome = outcome;
    final ReviewQueue current = state.value ?? initial;
    state = AsyncValue<ReviewQueue>.data(
      current.copyWith(
        items: current.items
            .where((ReviewQueueItem item) => item.hole.id != holeId)
            .toList(growable: false),
      ),
    );
    return true;
  }
}

void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

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
        items: <ReviewQueueItem>[
          ReviewQueueItem(
            hole: currentHole,
            daysSince: 0,
            prompt: '今回の穴',
            quiz: '今回の穴を言える?',
          ),
          ReviewQueueItem(
            hole: sameTopicButUnrelatedHole,
            daysSince: 1,
            prompt: '関係しない過去の穴',
            quiz: '解の公式で符号を変える理由を言える?',
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

      await tester.tap(find.text(ja.reviewNotYet));
      await tester.pumpAndSettle();

      expect(find.text(ja.holeSelfReportQuestion), findsNothing);
      expect(controller.answeredHoleId, isNull);
    });

    testWidgets('「言えるようになった」を選んだときだけ自己申告APIの操作へ渡す', (
      WidgetTester tester,
    ) async {
      final RecordingReviewController controller = await pumpLessonKarte(
        tester,
      );

      await tester.tap(find.text(ja.reviewSaidIt));
      await tester.pumpAndSettle();

      expect(controller.answeredHoleId, relevantHole.id);
      expect(controller.answeredOutcome, ReviewOutcome.saidIt);
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
      expect(find.text(en.reviewSaidIt), findsOneWidget);
      expect(find.text(en.reviewNotYet), findsOneWidget);
      expect(find.text(en.holeSelfReportLater), findsOneWidget);
    });
  });
}
