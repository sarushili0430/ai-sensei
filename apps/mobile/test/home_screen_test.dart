import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// ホームの「今日の1手」(ADR 0006)。
///
/// 見るのは**下に押せる操作がいくつあるか**。並べ直すPRはここで落ちる。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const ValueKey<String> lessonKey = ValueKey<String>('home-primary-lesson');
  const ValueKey<String> reviewKey = ValueKey<String>('home-primary-review');

  /// 締めたうえで、復習問題も残っていない日。
  /// `exhaustedSummary` は問題が3つあるので、この経路はこちらでしか通せない。
  const ProgressSummary exhaustedWithoutProblems = ProgressSummary(
    progress: Progress(
      streakDays: 3,
      filledHoles: 4,
      openHoles: 7,
      solvedProblems: 12,
      openProblems: 0,
    ),
    isPremium: false,
    limits: SessionLimits(
      maxSeconds: 1200,
      remainingSecondsToday: 0,
      lessonAllowedToday: false,
    ),
  );

  Future<void> pumpHome(
    WidgetTester tester,
    ProgressSummary summary, {
    Locale locale = const Locale('ja'),
  }) => pumpApp(
    tester,
    const HomeScreen(),
    locale: locale,
    overrides: <Object?>[
      progressControllerProvider.overrideWith(
        () => FakeProgressController(summary),
      ),
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(samplePracticeQueue),
      ),
    ],
  );

  testWidgets('授業ができる日は「先輩に教わる」1本だけ', (WidgetTester tester) async {
    await pumpHome(tester, sampleSummary);

    expect(find.byKey(lessonKey), findsOneWidget);
    expect(find.byKey(reviewKey), findsNothing);
    expect(find.text(ja.homeGreeting), findsOneWidget);
    // 締めていない日に「今日はここまで」を先出ししない(残数の匂わせになる)。
    expect(find.text(ja.lessonEnoughForToday), findsNothing);
    expect(find.text(ja.homeRemainingMinutes(20)), findsOneWidget);
  });

  testWidgets('残り秒数は分未満を切り捨てて、今日の残りとして出す', (WidgetTester tester) async {
    const ProgressSummary partial = ProgressSummary(
      progress: sampleProgress,
      isPremium: false,
      limits: SessionLimits(
        maxSeconds: 600,
        remainingSecondsToday: 599,
        lessonAllowedToday: true,
      ),
    );

    await pumpHome(tester, partial);

    expect(
      find.byKey(const ValueKey<String>('home-remaining-time')),
      findsOneWidget,
    );
    expect(find.text(ja.homeRemainingMinutes(9)), findsOneWidget);
  });

  for (final int seconds in <int>[59, 1]) {
    testWidgets('残り$seconds秒は0分ではなく「1分未満」と出す', (WidgetTester tester) async {
      final ProgressSummary partial = ProgressSummary(
        progress: sampleProgress,
        isPremium: false,
        limits: SessionLimits(
          maxSeconds: 600,
          remainingSecondsToday: seconds,
          lessonAllowedToday: true,
        ),
      );

      await pumpHome(tester, partial);

      expect(find.text(ja.homeRemainingLessThanMinute), findsOneWidget);
      expect(find.text(ja.homeRemainingMinutes(0)), findsNothing);
    });
  }

  testWidgets('先輩が締めた日は、押せる先が復習に入れ替わる', (WidgetTester tester) async {
    await pumpHome(tester, exhaustedSummary);

    expect(find.byKey(reviewKey), findsOneWidget);
    // 押せないボタンを並べて残さない。同じ場所の中身が入れ替わる。
    expect(find.byKey(lessonKey), findsNothing);
    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    // 使い切った0秒を「1分未満」に含めると、まだ残っている表示と説明が並んでしまう。
    expect(find.text(ja.homeRemainingMinutes(0)), findsOneWidget);
    expect(find.text(ja.homeRemainingLessThanMinute), findsNothing);
    // 撮らせない画面で「どこでつまずいた?」と聞かない。
    expect(find.text(ja.homeGreetingDone), findsOneWidget);
    expect(find.text(ja.homeGreeting), findsNothing);
  });

  testWidgets('締めていて復習問題も無ければ、そこで初めて押せないボタンになる', (WidgetTester tester) async {
    await pumpHome(tester, exhaustedWithoutProblems);

    expect(find.byKey(lessonKey), findsOneWidget);
    expect(find.byKey(reviewKey), findsNothing);
    expect(
      tester.widget<ChunkyButton>(find.byKey(lessonKey)).onPressed,
      isNull,
      reason: '押せる先が無い日は、押せるように見せない',
    );
  });

  // 数字を描くのは CountUpText だけ(#136)。ラベルにも数を持たせると
  // 「3 3日つづけて説明中」と同じ数が2回出る。ホーム初版からのバグで、
  // golden も最初からその絵で焼かれていたため検知できなかった。
  // 見えている数の**回数**をここで固定する。
  group('カウンターの数字', () {
    testWidgets('数字は各カウンターに1回だけ出て、読み上げは自然文のまま', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await pumpHome(tester, sampleSummary);

      expect(find.text('3'), findsOneWidget);
      expect(find.text('12'), findsOneWidget);
      // ラベル側は数字を持たない。空白の有無も文字列が持つ。
      expect(find.text(ja.streakDaysSuffix), findsOneWidget);
      expect(find.text(ja.solvedProblemsSuffix), findsOneWidget);
      // 数字入りの全文は、画面ではなく読み上げにだけ出す。
      expect(find.text(ja.streakDays(3)), findsNothing);
      expect(find.text(ja.solvedProblems(12)), findsNothing);
      expect(find.bySemanticsLabel(ja.streakDays(3)), findsOneWidget);
      expect(find.bySemanticsLabel(ja.solvedProblems(12)), findsOneWidget);
      handle.dispose();
    });

    // 初回起動がいちばんひどかった(0が4連発)。
    testWidgets('初回起動でも、0はカウンターごとに1回', (WidgetTester tester) async {
      await pumpHome(tester, firstRunSummary);

      expect(find.text('0'), findsNWidgets(2));
      expect(find.text(ja.streakDays(0)), findsNothing);
      expect(find.text(ja.solvedProblems(0)), findsNothing);
    });

    // 英語は数字が前(「4 gaps filled」)。前後どちらに置いても1回になる。
    testWidgets('英語でも数字は1回だけ', (WidgetTester tester) async {
      const AppStrings en = AppStrings(Locale('en'));
      await pumpHome(tester, sampleSummary, locale: const Locale('en'));

      expect(find.text('3'), findsOneWidget);
      expect(find.text('12'), findsOneWidget);
      expect(find.text(en.streakDaysSuffix), findsOneWidget);
      expect(find.text(en.solvedProblemsSuffix), findsOneWidget);
      expect(find.text(en.solvedProblems(12)), findsNothing);
    });
  });

  // Premium のフェアユース上限では、すでに契約している人へ課金導線を重ねない(§6-3)。
  testWidgets('Premiumが締められた日は、契約への道を出さない', (WidgetTester tester) async {
    await pumpHome(tester, premiumExhaustedSummary);

    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    expect(find.text(ja.homeUnlock), findsNothing);
  });
}
