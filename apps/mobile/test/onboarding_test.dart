import 'package:ai_sensei/src/common_widgets/marker_text.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_rehearsal.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/latex_element_view.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// オンボーディングのリハーサル(3枚目)。
///
/// ここで見ているのは見た目ではなく、**約束が操作として成立しているか**。
///   - 先輩が板書で教えたうえで、教え返すところまで1往復できるか
///   - パスしても先へ進めるか。パスが穴として**価値化**されているか
///   - 声も写真も使わないまま1往復できるか(権限を先に要求していないか)
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  /// 寸法は [pumpApp] が実機のものに固定する。
  ///
  /// 既定の 800×600 のままだと、板書を積んで縦に伸びたリハーサルの枚で
  /// 「うまく言えない」がビューポートの外に出て、`tap` が当たらないまま
  /// **黙って何も起きない**(それでもテストは緑になる)。
  Future<void> pumpOnboarding(
    WidgetTester tester, {
    Locale locale = const Locale('ja'),
    Size size = phoneSurface,
  }) => pumpApp(tester, const OnboardingScreen(), locale: locale, size: size);

  /// 「つぎへ」で [page] 枚目(0始まり)まで進める。
  Future<void> advanceTo(WidgetTester tester, int page, {AppStrings strings = ja}) async {
    for (int i = 0; i < page; i++) {
      await tester.tap(find.text(strings.onboardingNext));
      await tester.pumpAndSettle();
    }
  }

  /// 長押しして教え返す。押している時間は操作なので、
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
    await pumpOnboarding(tester);
    expect(find.text(ja.onboardingTitle), findsOneWidget);
  });

  testWidgets('リハーサルは、まだ録音しないことを画面に書く', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    expect(find.text(ja.onboardingTryQuestion), findsOneWidget);
    expect(find.text(ja.onboardingTryNotRecording), findsOneWidget);
  });

  // 改正後の約束(§0)の前半 —「教える」がリハーサルにも出ていること。
  // 板書を出さずに聞くだけに戻ると、この枚は改正前の台本に逆戻りする。
  //
  // 本番と同じ `BoardView` を使っているかまで見るのは、見た目を作り直した
  // 別物にすり替わると、リハーサルが授業モードの下見として機能しなくなるため。
  testWidgets('リハーサルは、聞く前に先輩が板書で教える', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    expect(find.text(ja.onboardingTryBoardLabel), findsOneWidget);

    final BoardView board = tester.widget<BoardView>(find.byType(BoardView));
    expect(board.steps.length, 2, reason: '板書は1〜2手順。ここが空だと「教える」が消える');
    expect(find.text(ja.onboardingTryBoardText), findsOneWidget);
    expect(find.byType(LatexElementView), findsOneWidget);
  });

  // **この枚は「読ませる枚」ではなく「やらせる枚」。**
  // 板書が全部見えないことより、操作が初期表示に無いことのほうが重い
  // (やることがある枚だと気づかれないまま、そのままスワイプされる)。
  // 板書を積んで縦に伸びたぶん、いちばん狭い実機でここが破れやすい。
  for (final Locale locale in <Locale>[const Locale('ja'), const Locale('en')]) {
    final AppStrings s = AppStrings(locale);

    testWidgets('狭い端末でも操作が折り返しの上にある (${locale.languageCode})', (WidgetTester tester) async {
      await pumpOnboarding(tester, locale: locale, size: smallPhoneSurface);
      await advanceTo(tester, 2, strings: s);

      // スクロールさせずに押せること。`ensureVisible` を挟んだら意味がない。
      expect(tester.getRect(find.text(s.onboardingTryHold)).bottom, lessThan(smallPhoneSurface.height));
      expect(tester.getRect(find.text(s.sessionPass)).bottom, lessThan(smallPhoneSurface.height));

      await tester.tap(find.text(s.sessionPass));
      await tester.pumpAndSettle();
      expect(find.text(s.onboardingTryHoleReaction), findsOneWidget);
      expect(tester.getRect(find.text(s.onboardingTryAgain)).bottom, lessThan(smallPhoneSurface.height));
    });
  }

  // 切れているのに手がかりが無いのが、いちばん悪い状態
  // (計画書§3-6b が横スクロールを不採用にした理由の縦版)。
  // 逆に、切れていないのに出続けるのは嘘なので、両方向を見る。
  testWidgets('板書が切れる端末でだけ、下に続く手がかりを出す', (WidgetTester tester) async {
    await pumpOnboarding(tester, size: smallPhoneSurface);
    await advanceTo(tester, 2);
    expect(find.byKey(onboardingBoardMoreBelowKey), findsOneWidget);
  });

  testWidgets('板書が収まる端末では、手がかりを出さない', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);
    expect(find.byKey(onboardingBoardMoreBelowKey), findsNothing);
  });

  // 操作(長押し)と「つぎへ」が縦に2つ並ぶので、主従が見分けられること。
  // 見た目の重さは `つぎへ` のほうが上(塗りつぶしの厚いボタン)だが、
  // **教え返す前は `つぎへ` が無効**なので、色がついているのは操作だけになる。
  // その保証がこのテスト。
  testWidgets('リハーサルを通るまで「つぎへ」は押せない', (WidgetTester tester) async {
    await pumpOnboarding(tester);
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

  testWidgets('長押しして教え返すと、言えたこととして黄マーカーが残る', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);
    await holdToExplain(tester);

    expect(find.text(ja.onboardingTrySaidReaction), findsOneWidget);

    final MarkerText marker = tester.widget<MarkerText>(find.byType(MarkerText));
    expect(marker.marker, MarkerColor.said);
    expect(marker.text, ja.onboardingTrySaid);
  });

  // §0 の約束3。パスは失敗ではなく、穴という**持ち帰るもの**になる。
  testWidgets('うまく言えなくても進める。穴はピンクで残り、責める文言を出さない', (WidgetTester tester) async {
    await pumpOnboarding(tester);
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
    await pumpOnboarding(tester);
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
    await pumpOnboarding(tester, locale: const Locale('en'));

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
    await pumpOnboarding(tester);
    await advanceTo(tester, 2);

    await tester.tap(find.text(ja.sessionPass));
    await tester.pumpAndSettle();

    await tester.tap(find.text(ja.onboardingTryAgain));
    await tester.pumpAndSettle();

    expect(find.text(ja.onboardingTryHold), findsOneWidget);
    expect(find.byType(MarkerText), findsNothing);
  });
}
