import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/common_widgets/marker_text.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_practice.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_rehearsal.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_stage.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/latex_element_view.dart';
import 'package:ai_sensei/src/features/settings/application/school_stage_controller.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/harness.dart';

/// オンボーディング。
///
/// 見ているのは見た目ではなく、**約束が操作として成立しているか**:
///   - 説明しているループが、いま実装されているループか(ADR 0009)
///   - 板書で教わって「わかった」を押すまでを、1往復できるか
///   - **3日後に聞かれて、書いて、採点される**までを1往復できるか
///   - 声も写真も使わないまま通せるか(権限を先に要求していないか)
///
/// 旧オンボーディング(教え返し → カルテ)の検査はここに残していない。
/// **どちらも実装に無い**ので、残すと消えた機能を守るテストになる。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  /// 寸法は [pumpApp] が実機のものに固定する。
  ///
  /// 既定の 800×600 のままだと、板書を積んで縦に伸びたリハーサルの枚で
  /// 操作がビューポートの外に出て、`tap` が当たらないまま
  /// **黙って何も起きない**(それでもテストは緑になる)。
  Future<void> pumpOnboarding(
    WidgetTester tester, {
    Locale locale = const Locale('ja'),
    Size size = phoneSurface,
    List<Object?> overrides = const <Object?>[],
  }) => pumpApp(
    tester,
    const OnboardingScreen(),
    locale: locale,
    size: size,
    overrides: overrides,
  );

  Future<void> tapNext(WidgetTester tester, AppStrings strings) async {
    await tester.tap(find.text(strings.onboardingNext));
    await tester.pumpAndSettle();
  }

  Future<void> chooseStage(
    WidgetTester tester,
    SchoolStage stage,
  ) async {
    await tester.tap(find.byKey(onboardingStageKey(stage)));
    await tester.pumpAndSettle();
  }

  /// 授業のリハーサルまで進める。日本語は途中で学年を1つ選ぶ。
  Future<void> goToLesson(WidgetTester tester, {AppStrings strings = ja}) async {
    await tapNext(tester, strings);
    if (strings.locale.languageCode == 'ja') {
      await chooseStage(tester, SchoolStage.juniorHigh);
      await tapNext(tester, strings);
    }
    await tapNext(tester, strings);
  }

  Future<void> pressUnderstood(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('onboarding-understood')));
    await tester.pumpAndSettle();
  }

  /// 復習のリハーサルまで進める。
  Future<void> goToPractice(WidgetTester tester, {AppStrings strings = ja}) async {
    await goToLesson(tester, strings: strings);
    await pressUnderstood(tester);
    await tapNext(tester, strings);
  }

  /// 通知を開いて、書いて、こたえる。**キーボードは出ない**(タップすると書かれる)。
  Future<void> answerPractice(WidgetTester tester, {AppStrings strings = ja}) async {
    await tester.tap(find.byKey(const Key('onboarding-practice-open')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('onboarding-practice-write')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('onboarding-practice-submit')));
    await tester.pumpAndSettle();
  }

  testWidgets('1枚目は機能ではなく約束から始まる', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    expect(find.text(ja.onboardingTitle), findsOneWidget);
  });

  // ADR 0009 が畳んだもの(教え返し・カルテ)を、説明の側に残さない。
  // ここが緑のまま腐ると、**オンボーディングだけが存在しない機能を約束する**。
  testWidgets('やることは、いまのループを説明する', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    await tapNext(tester, ja);
    await chooseStage(tester, SchoolStage.highSchool);
    await tapNext(tester, ja);

    expect(find.text(ja.onboardingStepCapture), findsOneWidget);
    expect(find.text(ja.onboardingStepTaught), findsOneWidget);
    expect(find.text(ja.onboardingStepUnderstood), findsOneWidget);
    expect(
      find.text(ja.onboardingStepPractice),
      findsOneWidget,
      reason: '復習問題の出どころ(その日の板書)が消えると、3/7日の再訪の根拠ごと崩れる',
    );
  });

  group('学年', () {
    testWidgets('日本語では2枚目で聞く。選ぶまで先へ進めない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await tapNext(tester, ja);

      expect(find.text(ja.onboardingStageTitle), findsOneWidget);

      // 選ぶ前に押しても、この枚に留まる。
      await tapNext(tester, ja);
      expect(find.text(ja.onboardingStageTitle), findsOneWidget);

      await chooseStage(tester, SchoolStage.juniorHigh);
      await tapNext(tester, ja);
      expect(find.text(ja.onboardingHowTitle), findsOneWidget);
    });

    // 既定は高校生。**聞いておいて答えを先回りしない**ので、
    // 触っていないうちは端末にも書かない。
    testWidgets('選んだ段階が端末に残る', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences preferences = await SharedPreferences.getInstance();
      final ProviderContainer container = ProviderContainer(
        overrides: <Object?>[preferencesProvider.overrideWithValue(preferences)].cast(),
      );
      addTearDown(container.dispose);

      await setSurface(tester);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: wrapApp(const OnboardingScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(container.read(schoolStageControllerProvider), SchoolStage.highSchool);

      await tapNext(tester, ja);
      await chooseStage(tester, SchoolStage.juniorHigh);

      expect(container.read(schoolStageControllerProvider), SchoolStage.juniorHigh);
    });

    // 海外課程は段階で分かれていない(`tracksForStage` が locale=="en" を
    // どちらの段階でも同じ1本に落とす)。答えが何も変えない質問は出さない。
    testWidgets('英語では聞かない', (WidgetTester tester) async {
      await pumpOnboarding(tester, locale: const Locale('en'));
      await tapNext(tester, en);

      expect(find.text(en.onboardingStageTitle), findsNothing);
      expect(find.text(en.onboardingHowTitle), findsOneWidget);
    });
  });

  group('授業のリハーサル', () {
    testWidgets('まだ写真も声も使わないことを画面に書く', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);

      expect(find.text(ja.onboardingTryTeachLine), findsOneWidget);
      expect(find.text(ja.onboardingTryNotRecording), findsOneWidget);
    });

    // 約束の前半 —「教える」がリハーサルにも出ていること。
    // 本番と同じ `BoardView` を使っているかまで見るのは、見た目を作り直した
    // 別物にすり替わると、リハーサルが授業モードの下見として機能しなくなるため。
    testWidgets('押す前に、先輩が板書で教える', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);

      expect(find.text(ja.onboardingTryBoardLabel), findsOneWidget);

      final BoardView board = tester.widget<BoardView>(find.byType(BoardView));
      expect(board.steps.length, 2, reason: '板書は1〜2手順。ここが空だと「教える」が消える');
      expect(board.title, ja.onboardingTryBoardTitle);
      expect(find.text(ja.onboardingTryBoardText), findsOneWidget);
      expect(find.byType(LatexElementView), findsOneWidget);
    });

    // 操作(わかった)と「つぎへ」が縦に2つ並ぶので、主従が見分けられること。
    // **押す前は「つぎへ」が無効**なので、色がついているのは操作だけになる。
    testWidgets('「わかった」を押すまで「つぎへ」は押せない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);

      // 行き止まりにはしない。ここから「とばす」が出る。
      expect(find.text(ja.onboardingSkip), findsOneWidget);

      await tapNext(tester, ja);
      expect(
        find.text(ja.onboardingTryTeachLine),
        findsOneWidget,
        reason: 'まだ「わかった」を押していないうちは、リハーサルの枚に留まる',
      );
    });

    // ADR 0009「生成の完了を待たせない」。押した瞬間に1問できる。
    testWidgets('「わかった」を押すと、その場で復習問題が1問できる', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);
      await pressUnderstood(tester);

      expect(find.text(ja.onboardingTryUnderstoodReaction), findsOneWidget);
      expect(find.byKey(onboardingMadeProblemKey), findsOneWidget);
      expect(find.text(ja.onboardingPracticeQuestion), findsOneWidget);
      expect(
        find.text(ja.onboardingTryNotWaiting),
        findsOneWidget,
        reason: '待たされないことを、待っていないその場で言う',
      );
    });

    testWidgets('やり直せる。選び直しても責めない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);
      await pressUnderstood(tester);

      await tester.tap(find.text(ja.onboardingTryAgain));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('onboarding-understood')), findsOneWidget);
      expect(find.byKey(onboardingMadeProblemKey), findsNothing);
    });

    // 切れているのに手がかりが無いのが、いちばん悪い状態
    // (計画書§3-6b が横スクロールを不採用にした理由の縦版)。
    // 逆に、切れていないのに出続けるのは嘘なので、両方向を見る。
    testWidgets('板書が切れる端末でだけ、下に続く手がかりを出す', (WidgetTester tester) async {
      await pumpOnboarding(tester, size: smallPhoneSurface);
      await goToLesson(tester);
      expect(find.byKey(onboardingBoardMoreBelowKey), findsOneWidget);
    });

    testWidgets('板書が収まる端末では、手がかりを出さない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);
      expect(find.byKey(onboardingBoardMoreBelowKey), findsNothing);
    });
  });

  group('復習のリハーサル', () {
    // **この枚が、手元の無料AIとの差そのもの。**読み物にすると
    // 「3日後に聞く」が言っただけの約束になる。
    testWidgets('3日後の通知が届き、書いて、採点されるまでを通せる', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToPractice(tester);

      expect(find.byKey(onboardingPushKey), findsOneWidget);
      expect(find.text(ja.onboardingPushTitle), findsOneWidget);

      // 通知は**押せる**。開いて初めて問題が出る(本番の着地先と同じ順)。
      await tester.tap(find.byKey(onboardingPushKey));
      await tester.pumpAndSettle();
      expect(find.text(ja.onboardingPracticeQuestion), findsOneWidget);
      expect(find.byKey(onboardingPushKey), findsNothing);

      await tester.tap(find.byKey(const Key('onboarding-practice-write')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('onboarding-practice-submit')));
      await tester.pumpAndSettle();

      expect(find.byKey(onboardingVerdictKey), findsOneWidget);

      // 判定は本番と同じ言葉・同じマーカー(黄)。点数は出さない。
      final MarkerText marker = tester.widget<MarkerText>(find.byType(MarkerText));
      expect(marker.text, ja.practiceCorrect);
      expect(marker.marker, MarkerColor.said);

      // 作成時に決めた段は取り消さない(ADR 0009)ので、7日後は残る。
      expect(find.text(ja.practiceNextSchedule(const <int>[7])), findsOneWidget);
    });

    testWidgets('採点まで通るまで「つぎへ」は押せない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToPractice(tester);

      await tapNext(tester, ja);
      expect(
        find.byKey(onboardingPushKey),
        findsOneWidget,
        reason: 'まだ答えていないうちは、復習の枚に留まる',
      );

      await answerPractice(tester);
      await tapNext(tester, ja);
      expect(find.text(ja.onboardingReadyTitle), findsOneWidget);
    });
  });

  // **やらせる枚**は、操作が初期表示に無いと存在理由が消える
  // (やることがある枚だと気づかれないまま、そのままスワイプされる)。
  // 板書を積んで縦に伸びたぶん、いちばん狭い実機でここが破れやすい。
  for (final AppStrings s in <AppStrings>[ja, en]) {
    final String lang = s.locale.languageCode;

    testWidgets('狭い端末でも操作が折り返しの上にある ($lang)', (WidgetTester tester) async {
      await pumpOnboarding(tester, locale: s.locale, size: smallPhoneSurface);
      await goToLesson(tester, strings: s);

      // スクロールさせずに押せること。`ensureVisible` を挟んだら意味がない。
      expect(
        tester.getRect(find.text(s.sessionUnderstood)).bottom,
        lessThan(smallPhoneSurface.height),
      );

      await pressUnderstood(tester);
      await tapNext(tester, s);

      // 復習の枚も同じ。**書き始める口が折り返しの下にあると、
      // `tap` は何も起こさないまま静かに外れる**(harness.dart の警告そのもの)。
      // 通ったかどうかは座標ではなく、**押した結果が出たか**で見る。
      await answerPractice(tester, strings: s);
      expect(find.byKey(onboardingVerdictKey), findsOneWidget);
    });
  }

  // **関門は指にも効く。**「つぎへ」を無効にするだけでは、横にスワイプして
  // 素通りできた。学年を選ばずに抜けられると、中学生が黙って高校の単元を
  // 候補にされたまま本編に入る(既定が高校生なので、素通りがいちばん悪い)。
  group('スワイプでも関門を越えられない', () {
    /// 次の枚へ送るだけの幅で横に払う。
    Future<void> swipeForward(WidgetTester tester) async {
      await tester.drag(find.byType(PageView), const Offset(-500, 0));
      await tester.pumpAndSettle();
    }

    testWidgets('学年を選ぶまで、その枚から動かない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await tapNext(tester, ja);

      await swipeForward(tester);
      expect(find.text(ja.onboardingStageTitle), findsOneWidget);

      await chooseStage(tester, SchoolStage.juniorHigh);
      await swipeForward(tester);
      expect(find.text(ja.onboardingHowTitle), findsOneWidget);
    });

    testWidgets('「わかった」を押すまで、授業のリハーサルから動かない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);

      await swipeForward(tester);
      expect(find.text(ja.onboardingTryTeachLine), findsOneWidget);

      await pressUnderstood(tester);
      await swipeForward(tester);
      expect(find.byKey(onboardingPushKey), findsOneWidget);
    });

    testWidgets('採点まで通るまで、復習のリハーサルから動かない', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToPractice(tester);

      await swipeForward(tester);
      expect(find.byKey(onboardingPushKey), findsOneWidget);

      await answerPractice(tester);
      await swipeForward(tester);
      expect(find.text(ja.onboardingReadyTitle), findsOneWidget);
    });

    // **戻る向きは塞がない。**この画面に戻るボタンは無く、
    // スワイプだけが手前の枚へ帰る道。
    testWidgets('関門の枚からでも、手前へは戻れる', (WidgetTester tester) async {
      await pumpOnboarding(tester);
      await goToLesson(tester);

      await tester.drag(find.byType(PageView), const Offset(500, 0));
      await tester.pumpAndSettle();
      expect(find.text(ja.onboardingHowTitle), findsOneWidget);
    });
  });

  // 出口を作るのは、やってみる枚から。約束とやることは飛ばさせない。
  testWidgets('「とばす」はリハーサルから出る', (WidgetTester tester) async {
    await pumpOnboarding(tester);
    expect(find.text(ja.onboardingSkip), findsOneWidget);

    // 出ていても、まだ押せない(不透明度0のまま無効)。
    final TextButton skip = tester.widget<TextButton>(
      find.ancestor(of: find.text(ja.onboardingSkip), matching: find.byType(TextButton)),
    );
    expect(skip.onPressed, isNull);

    await goToLesson(tester);
    final TextButton enabled = tester.widget<TextButton>(
      find.ancestor(of: find.text(ja.onboardingSkip), matching: find.byType(TextButton)),
    );
    expect(enabled.onPressed, isNotNull);
  });

  // 審査員が見るのは英語版。日本語で組んだ余白に長い英文を流し込むとはみ出す。
  testWidgets('英語ロケールでも最後まで通せる', (WidgetTester tester) async {
    await pumpOnboarding(tester, locale: const Locale('en'));
    await goToPractice(tester, strings: en);
    await answerPractice(tester, strings: en);
    await tapNext(tester, en);

    expect(find.text(en.onboardingReadyTitle), findsOneWidget);
    expect(find.text(en.onboardingReviewDay7), findsOneWidget);
    expect(find.text(en.onboardingCta), findsOneWidget);
  });
}
