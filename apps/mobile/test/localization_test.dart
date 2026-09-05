import 'package:ai_sensei/src/common_widgets/senpai_face.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// 日本語と英語の2ロケール。
///
/// 見ているのは訳の出来ではなく、**日本語が海外のユーザーに出ないこと**と、
/// 画面に出る単元名がサーバ(カリキュラム)の言語のまま素通しされること。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  group('端末の言語の解決', () {
    // Flutter の既定は「一致しなければ supportedLocales の先頭」。
    // 何もしないとスペイン語の端末に日本語が出る。
    test('日本語を望んだ端末にだけ日本語を出す', () {
      expect(
        AppStrings.resolve(<Locale>[const Locale('ja', 'JP')]),
        const Locale('ja'),
      );
      expect(
        AppStrings.resolve(<Locale>[const Locale('en', 'US')]),
        const Locale('en'),
      );
      expect(
        AppStrings.resolve(<Locale>[const Locale('es', 'ES')]),
        const Locale('en'),
      );
      expect(
        AppStrings.resolve(<Locale>[const Locale('fr'), const Locale('ja')]),
        const Locale('ja'),
      );
    });

    test('端末が言語を返さないときは日本語', () {
      expect(AppStrings.resolve(null), const Locale('ja'));
      expect(AppStrings.resolve(<Locale>[]), const Locale('ja'));
    });

    test('BuildContextなしでも同じ文言を引ける(コントローラから使う)', () {
      expect(AppStrings.forLanguage('en').errorNetwork, en.errorNetwork);
      expect(AppStrings.forLanguage('ja').errorNetwork, ja.errorNetwork);
      expect(en.errorNetwork, isNot(ja.errorNetwork));
    });
  });

  group('読み上げのラベル', () {
    testWidgets('先輩の表情のラベルもロケールに従う', (WidgetTester tester) async {
      await tester.pumpWidget(
        wrapApp(
          const Scaffold(body: SenpaiFace(mood: SenpaiMood.delighted)),
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel(en.senpaiDelighted), findsOneWidget);
      expect(find.bySemanticsLabel(ja.senpaiDelighted), findsNothing);
    });
  });

  group('授業の降り方', () {
    test('到達と離脱の文言を日英それぞれで持つ', () {
      expect(ja.sessionUnderstood, 'わかった');
      expect(en.sessionUnderstood, 'Got it');
      expect(ja.sessionQuitTitle, '授業をやめる?');
      expect(en.sessionQuitTitle, 'Leave this lesson?');
      expect(en.sessionQuitBody, isNot(contains('復習問題')));
      expect(en.sessionContinue, 'Keep going');
      expect(en.sessionQuit, 'Leave');
    });
  });

  group('復習問題画面(英語)', () {
    // 単元名はサーバのカリキュラムが持っている。海外の課程で始めた
    // セッションなら "Algebra 1 / ..." が返り、アプリはそれをそのまま出す。
    final PracticeQueue englishQueue = PracticeQueue(
      items: <PracticeQueueItem>[
        PracticeQueueItem(
          problem: PracticeProblem(
            id: 'prb_en',
            sessionId: 'ses_en',
            boardId: 'brd_en',
            topicId: 'A1-QUAD-SOLVE',
            question: 'How many real solutions does x² − 6x + 5 = 0 have?',
            createdAt: DateTime.utc(2026, 8, 3, 13, 24, 7),
          ),
          daysSince: 3,
          topicLabel: 'Algebra 1 / Discriminant',
          lastVerdict: null,
        ),
      ],
    );

    testWidgets('英語の復習問題を、日本語を混ぜずに組める', (WidgetTester tester) async {
      await tester.pumpWidget(
        wrapApp(
          const ReviewScreen(),
          locale: const Locale('en'),
          overrides: <Object?>[
            reviewControllerProvider.overrideWith(
              () => FakeReviewController(englishQueue),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text(en.practiceHeader(3)), findsOneWidget);
      expect(find.text('Algebra 1 / Discriminant'), findsOneWidget);
      expect(
        find.text('How many real solutions does x² − 6x + 5 = 0 have?'),
        findsOneWidget,
      );
      expect(find.text(en.practiceSubmit), findsOneWidget);
      expect(find.text(ja.practiceHeader(3)), findsNothing);
    });
  });
}
