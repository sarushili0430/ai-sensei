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
/// 見ているのは**画面のいちばん下に押せる操作がいくつあるか**。以前はここに
/// 授業と自習室の2本が並び、先輩が今日を締めた日は色を入れ替えて「押せるほう」を
/// 示していた。自習室を畳んでからは、同じ場所のボタンの中身を差し替える形にした
/// (`_PrimaryAction`)。並べ直すPRを出すと、ここが落ちる。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const ValueKey<String> lessonKey = ValueKey<String>('home-primary-lesson');
  const ValueKey<String> reviewKey = ValueKey<String>('home-primary-review');

  /// 締めたうえで、埋める穴も残っていない日。
  ///
  /// `exhaustedSummary` は穴が2つ残っている状態なので、こちらでしか
  /// 「押せるボタンが1つも無い」経路を通せない。
  const ProgressSummary exhaustedWithoutHoles = ProgressSummary(
    progress: Progress(streakDays: 3, filledHoles: 4, openHoles: 0),
    isPremium: false,
    limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: false),
  );

  Future<void> pumpHome(WidgetTester tester, ProgressSummary summary) => pumpApp(
        tester,
        const HomeScreen(),
        overrides: <Object?>[
          progressControllerProvider.overrideWith(() => FakeProgressController(summary)),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
        ],
      );

  testWidgets('授業ができる日は「先輩に教わる」1本だけ', (WidgetTester tester) async {
    await pumpHome(tester, sampleSummary);

    expect(find.byKey(lessonKey), findsOneWidget);
    expect(find.byKey(reviewKey), findsNothing);
    expect(find.text(ja.homeGreeting), findsOneWidget);
    // 締めていない日に「今日はここまで」を先出ししない(残数の匂わせになる)。
    expect(find.text(ja.lessonEnoughForToday), findsNothing);
  });

  testWidgets('先輩が締めた日は、押せる先が復習に入れ替わる', (WidgetTester tester) async {
    await pumpHome(tester, exhaustedSummary);

    expect(find.byKey(reviewKey), findsOneWidget);
    // 押せないボタンを並べて残さない。同じ場所の中身が入れ替わる。
    expect(find.byKey(lessonKey), findsNothing);
    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    // 撮らせない画面で「どこでつまずいた?」と聞かない。
    expect(find.text(ja.homeGreetingDone), findsOneWidget);
    expect(find.text(ja.homeGreeting), findsNothing);
  });

  testWidgets('締めていて穴も無ければ、そこで初めて押せないボタンになる',
      (WidgetTester tester) async {
    await pumpHome(tester, exhaustedWithoutHoles);

    expect(find.byKey(lessonKey), findsOneWidget);
    expect(find.byKey(reviewKey), findsNothing);
    expect(
      tester.widget<ChunkyButton>(find.byKey(lessonKey)).onPressed,
      isNull,
      reason: '押せる先が無い日は、押せるように見せない',
    );
  });

  // Premium のフェアユース上限では、すでに契約している人へ課金導線を重ねない(§6-3)。
  testWidgets('Premiumが締められた日は、契約への道を出さない', (WidgetTester tester) async {
    await pumpHome(tester, premiumExhaustedSummary);

    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    expect(find.text(ja.homeUnlock), findsNothing);
  });
}
