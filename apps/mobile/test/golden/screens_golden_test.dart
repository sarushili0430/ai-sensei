@Tags(<String>['golden'])
library;

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/routing/routes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/harness.dart';

/// 主要画面の golden test。
///
/// 見ているのは「崩れていないか」よりも **設計上の約束が画面に出ているか**:
/// 点数が出ていないか、復習問題と解けた履歴が同じ画面にあるか、
/// ペイウォールに無料継続の導線が残っているか。
///
/// 生成はCI(Linux)を正とする:
///   flutter test --update-goldens
/// 端末やOSが違うとフォントラスタライズが変わるので、手元の差分はコミットしない。
void main() {
  setUpAll(loadAppFonts);

  Future<void> capture(WidgetTester tester, String name) => expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('goldens/$name.png'),
  );

  Future<void> expectGolden(
    WidgetTester tester,
    Widget screen,
    String name, {
    List<Object?> overrides = const <Object?>[],
  }) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(screen, overrides: overrides));
    await tester.pumpAndSettle();
    await capture(tester, name);
  }

  /// 常設タブ配下の画面を、本番と同じルータ込みで撮る。
  ///
  /// 画面だけを `MaterialApp.home` に置くと、下部ナビゲーションが丸ごと
  /// テスト対象から抜ける。ホームの高さがタブぶん縮んで操作が押し出される壊れ方も
  /// 見えなくなるので、シェル配下の既存goldenだけはこちらを通す。
  Future<void> expectRoutedGolden(
    WidgetTester tester,
    String location,
    String name, {
    ProgressSummary progress = firstRunSummary,
    PracticeQueue reviews = const PracticeQueue(items: <PracticeQueueItem>[]),
    List<Object?> overrides = const <Object?>[],
  }) async {
    await setSurface(tester);
    // 設定画面が学校段階を読む。`preferencesProvider` は main() で override する
    // 前提なので、ここでも入れないと設定の golden を撮る瞬間に落ちる。
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        preferencesProvider.overrideWithValue(preferences),
        onboardedProvider.overrideWithValue(true),
        deviceIdProvider.overrideWithValue(
          '11111111-2222-3333-4444-555555555555',
        ),
        progressControllerProvider.overrideWith(
          () => FakeProgressController(progress),
        ),
        reviewControllerProvider.overrideWith(
          () => FakeReviewController(reviews),
        ),
        ...overrides,
      ].cast(),
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(wrapRouter(container));
    await tester.pumpAndSettle();
    container.read(appRouterProvider).go(location);
    await tester.pumpAndSettle();
    await capture(tester, name);
  }

  const AppStrings ja = AppStrings(Locale('ja'));

  Future<void> tapNext(WidgetTester tester) async {
    await tester.tap(find.text(ja.onboardingNext));
    await tester.pumpAndSettle();
  }

  testWidgets('01 オンボーディング(約束)', (WidgetTester tester) async {
    await expectGolden(tester, const OnboardingScreen(), 'onboarding');
  });

  // リハーサル。ここで見たいのは、**答えが1文字も出ていない**こと。
  // 出ているのは質問と、説明する/言えない の2つの道だけ。
  testWidgets('01b オンボーディング(リハーサル)', (WidgetTester tester) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(const OnboardingScreen()));
    await tester.pumpAndSettle();

    await tapNext(tester);
    await tapNext(tester);
    await capture(tester, 'onboarding_rehearsal');
  });

  // パスしたあとのカルテ見本。穴がピンクで残り、責める言葉が無く、
  // 「また来る」ことが線で見えているか。
  testWidgets('01c オンボーディング(カルテの見本)', (WidgetTester tester) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(const OnboardingScreen()));
    await tester.pumpAndSettle();

    await tapNext(tester);
    await tapNext(tester);
    await tester.tap(find.text(ja.sessionPass));
    await tester.pumpAndSettle();
    await tapNext(tester);
    await capture(tester, 'onboarding_karte');
  });

  testWidgets('02 ホーム', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.home.path,
      'home',
      progress: sampleSummary,
      reviews: samplePracticeQueue,
    );
  });

  // 初回起動のホーム。押すもののない空白にせず、次の一歩を出しているか。
  testWidgets('02b ホーム(初回起動)', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.home.path,
      'home_first_run',
      progress: firstRunSummary,
    );
  });

  // 契約している人のホーム。右上に印が出ているか、
  // それが数えている2つ(連続日数・解けた問題)を押し出していないか。
  testWidgets('02c ホーム(Premium)', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.home.path,
      'home_premium',
      progress: premiumSummary,
      reviews: samplePracticeQueue,
      overrides: premiumOverrides(),
    );
  });

  testWidgets('03 祝福', (WidgetTester tester) async {
    await expectGolden(
      tester,
      const CelebrationScreen(),
      'celebration',
      overrides: <Object?>[
        progressControllerProvider.overrideWith(FakeProgressController.new),
        sessionOutcomeControllerProvider.overrideWith(
          () => FakeSessionOutcomeController(const SessionOutcome()),
        ),
      ],
    );
  });

  // 古いディープリンクの保存画像も、行き止まりではなく復習へ寄せられる絵に更新する。
  //
  // **PNGの名前も `karte` から替える。** カルテ画面はもう無く、ここが撮るのは
  // 寄せられた先の復習画面。`karte.png` のままだと、あとで開いた人が
  // 「カルテの絵が復習になっている = goldenが腐っている」と読んで焼き直す。
  testWidgets('04 旧カルテ導線から復習', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.karte.path,
      'karte_redirect',
      reviews: samplePracticeQueue,
    );
  });

  // 「解く問題」と「解けた問題」が同じ画面に並んでいるか。
  // 後者がペイウォールの謳う「履歴」で、別画面は作らない。
  testWidgets('05 復習(Premium)', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.review.path,
      'review',
      progress: premiumSummary,
      reviews: PracticeQueue(
        items: <PracticeQueueItem>[samplePracticeQueue.items.first],
        solved: <SolvedPractice>[sampleSolvedPractice],
      ),
    );
  });

  testWidgets('06 ペイウォール', (WidgetTester tester) async {
    await expectRoutedGolden(tester, AppRoute.paywall.path, 'paywall');
  });

  testWidgets('07 設定', (WidgetTester tester) async {
    await expectRoutedGolden(tester, AppRoute.settings.path, 'settings');
  });

  // 購入のお礼。見たいのは、祝っている画面でも
  // **更新日と解約できることが消えていない**こと(Guideline 3.1.2)。
  //
  // 無料トライアルの見出しは残り日数で変わる = 撮る日で変わるので、
  // golden では撮らない(文言の出し分けは monetization_test.dart で見る)。
  testWidgets('08 購入のお礼', (WidgetTester tester) async {
    await expectRoutedGolden(
      tester,
      AppRoute.thanks.path,
      'thanks',
      overrides: premiumOverrides(),
    );
  });
}
