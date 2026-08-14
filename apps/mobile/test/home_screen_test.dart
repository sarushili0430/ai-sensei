import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// Home's "today's move" (ADR 0006).
///
/// It checks how many tappable actions sit at the bottom; a PR that stacks them
/// fails here.
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const ValueKey<String> lessonKey = ValueKey<String>('home-primary-lesson');
  const ValueKey<String> reviewKey = ValueKey<String>('home-primary-review');

  /// A closed-out day with no gaps left either. `exhaustedSummary` has two gaps,
  /// so this path is only reachable here.
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
    // Do not pre-empt "done for today" on an open day; it hints at a remainder.
    expect(find.text(ja.lessonEnoughForToday), findsNothing);
  });

  testWidgets('先輩が締めた日は、押せる先が復習に入れ替わる', (WidgetTester tester) async {
    await pumpHome(tester, exhaustedSummary);

    expect(find.byKey(reviewKey), findsOneWidget);
    // No stacked disabled buttons; the same place swaps its contents.
    expect(find.byKey(lessonKey), findsNothing);
    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    // A screen that refuses the photo never asks "where did you get stuck?".
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

  // At the Premium fair-use cap, no billing prompt is stacked on a subscriber.
  testWidgets('Premiumが締められた日は、契約への道を出さない', (WidgetTester tester) async {
    await pumpHome(tester, premiumExhaustedSummary);

    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    expect(find.text(ja.homeUnlock), findsNothing);
  });
}
