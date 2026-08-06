import 'package:ai_sensei/src/common_widgets/marker_text.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// オンボーディングのリハーサル(3枚目)。
///
/// ここで見ているのは見た目ではなく、**約束が操作として成立しているか**。
///   - 答えを出していないか(模範解答を画面に置いていないか)
///   - パスしても先へ進めるか。パスが穴として**価値化**されているか
///   - 声も写真も使わないまま1往復できるか(権限を先に要求していないか)
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  /// 「つぎへ」で [page] 枚目(0始まり)まで進める。
  Future<void> advanceTo(WidgetTester tester, int page) async {
    for (int i = 0; i < page; i++) {
      await tester.tap(find.text(ja.onboardingNext));
      await tester.pumpAndSettle();
    }
  }

  /// 長押しして説明する。押している時間は操作なので、
  /// アニメーションを止めても短くならない(だから実時間ぶん進める)。
  Future<void> holdToExplain(WidgetTester tester) async {
    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(find.text(ja.onboardingTryHold)),
    );
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(AppDurations.hold + const Duration(milliseconds: 50));
    await gesture.up();
    await tester.pumpAndSettle();
  }

  testWidgets('1枚目は機能ではなく約束から始まる', (WidgetTester tester) async {
    await pumpApp(tester, const OnboardingScreen());
    expect(find.text(ja.onboardingTitle), findsOneWidget);
  });

  testWidgets('リハーサルは、まだ録音しないことを画面に書く', (WidgetTester tester) async {
    await pumpApp(tester, const OnboardingScreen());
    await advanceTo(tester, 2);

    expect(find.text(ja.onboardingTryQuestion), findsOneWidget);
    expect(find.text(ja.onboardingTryNotRecording), findsOneWidget);
  });

  testWidgets('リハーサルを通るまで「つぎへ」は押せない', (WidgetTester tester) async {
    await pumpApp(tester, const OnboardingScreen());
    await advanceTo(tester, 2);

    // 行き止まりにはしない。パスも「とばす」も出ている。
    expect(find.text(ja.sessionPass), findsOneWidget);
    expect(find.text(ja.onboardingSkip), findsOneWidget);

    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();
    expect(
      find.text(ja.onboardingTryQuestion),
      findsOneWidget,
      reason: '説明もパスもしていないうちは、リハーサルの枚に留まる',
    );
  });

  testWidgets('長押しして説明すると、言えたこととして黄マーカーが残る', (WidgetTester tester) async {
    await pumpApp(tester, const OnboardingScreen());
    await advanceTo(tester, 2);
    await holdToExplain(tester);

    expect(find.text(ja.onboardingTrySaidReaction), findsOneWidget);

    final MarkerText marker = tester.widget<MarkerText>(find.byType(MarkerText));
    expect(marker.marker, MarkerColor.said);
    expect(marker.text, ja.onboardingTrySaid);
  });

  // §0 の約束3。パスは失敗ではなく、穴という**持ち帰るもの**になる。
  testWidgets('うまく言えなくても進める。穴はピンクで残り、責める文言を出さない', (WidgetTester tester) async {
    await pumpApp(tester, const OnboardingScreen());
    await advanceTo(tester, 2);

    await tester.tap(find.text(ja.sessionPass));
    await tester.pumpAndSettle();

    final MarkerText marker = tester.widget<MarkerText>(find.byType(MarkerText));
    expect(marker.marker, MarkerColor.hole);
    expect(find.text(ja.onboardingTryHoleReaction), findsOneWidget);

    // パスしたあとも先へ進める。
    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();
    expect(find.text(ja.onboardingKarteTitle), findsOneWidget);
  });

  testWidgets('カルテの見本は、リハーサルでやったことをそのまま出す', (WidgetTester tester) async {
    await pumpApp(tester, const OnboardingScreen());
    await advanceTo(tester, 2);
    await holdToExplain(tester);

    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();

    // 説明できた人に、やっていない「穴」を書かない。
    expect(find.text(ja.onboardingTrySaid), findsOneWidget);
    expect(find.text(ja.onboardingTryHole), findsNothing);
    expect(find.text(ja.onboardingCta), findsOneWidget);
  });

  // 審査員が見るのは英語版(handoff §3-7)。日本語で組んだ余白に
  // 長い英文を流し込むとはみ出す。4枚とも通しで踏む。
  testWidgets('英語ロケールでも4枚とも組める', (WidgetTester tester) async {
    const AppStrings en = AppStrings(Locale('en'));
    await tester.pumpWidget(
      wrapApp(const OnboardingScreen(), locale: const Locale('en')),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text(en.onboardingNext));
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.onboardingNext));
    await tester.pumpAndSettle();
    expect(find.text(en.onboardingTryQuestion), findsOneWidget);

    await tester.tap(find.text(en.sessionPass));
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.onboardingNext));
    await tester.pumpAndSettle();

    expect(find.text(en.onboardingKarteTitle), findsOneWidget);
    expect(find.text(en.onboardingReviewDay7), findsOneWidget);
  });

  testWidgets('やり直せる。選び直しても責めない', (WidgetTester tester) async {
    await pumpApp(tester, const OnboardingScreen());
    await advanceTo(tester, 2);

    await tester.tap(find.text(ja.sessionPass));
    await tester.pumpAndSettle();

    await tester.tap(find.text(ja.onboardingTryAgain));
    await tester.pumpAndSettle();

    expect(find.text(ja.onboardingTryHold), findsOneWidget);
    expect(find.byType(MarkerText), findsNothing);
  });
}
