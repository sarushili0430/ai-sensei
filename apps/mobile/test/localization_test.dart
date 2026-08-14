import 'package:ai_sensei/src/common_widgets/senpai_face.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// The Japanese and English locales.
///
/// What is checked is not translation quality but that Japanese never reaches
/// overseas users, and that topic names pass through in the language the
/// server's curriculum returned.
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  group('端末の言語の解決', () {
    // Flutter defaults to the first supportedLocales entry on no match, so doing
    // nothing shows Japanese on a Spanish device.
    test('日本語を望んだ端末にだけ日本語を出す', () {
      expect(AppStrings.resolve(<Locale>[const Locale('ja', 'JP')]), const Locale('ja'));
      expect(AppStrings.resolve(<Locale>[const Locale('en', 'US')]), const Locale('en'));
      expect(AppStrings.resolve(<Locale>[const Locale('es', 'ES')]), const Locale('en'));
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

  group('カルテ画面(英語)', () {
    // Topic names come from the server's curriculum: a session started on an
    // international curriculum returns "Algebra 1 / ...", shown unchanged.
    final Karte englishKarte = Karte(
      id: 'kar_en',
      sessionId: 'ses_en',
      createdAt: DateTime.utc(2026, 8, 3, 13, 24, 7),
      topicIds: const <String>['A2-COORD-CIRCLE', 'A1-QUAD-SOLVE'],
      saidWell: const <String>[
        'Explained the plan of comparing the distance d with the radius r, with a reason',
      ],
      holes: <Hole>[
        Hole(
          id: 'hol_en',
          topicId: 'A1-QUAD-SOLVE',
          description: 'the explanation stopped at why the discriminant is used',
          severity: HoleSeverity.medium,
          status: HoleStatus.open,
          createdAt: DateTime.utc(2026, 8, 3, 13, 24, 7),
        ),
      ],
      termNotes: const <String>['"quadratic formula" and "discriminant" were mixed up'],
    );

    testWidgets('英語のカルテを、日本語を混ぜずに組める', (WidgetTester tester) async {
      await tester.pumpWidget(
        wrapApp(
          const KarteScreen(),
          locale: const Locale('en'),
          overrides: <Object?>[
            latestKarteControllerProvider.overrideWith(
              () => FakeLatestKarteController(englishKarte),
            ),
            sessionOutcomeControllerProvider.overrideWith(
              () => FakeSessionOutcomeController(const SessionOutcome()),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text(en.karteTitle), findsOneWidget);
      expect(find.text(en.karteSaidWell), findsOneWidget);
      expect(find.text(en.karteHoles(1)), findsOneWidget);
      expect(
        find.text('the explanation stopped at why the discriminant is used'),
        findsOneWidget,
      );
      expect(find.text(ja.karteTitle), findsNothing);
    });
  });
}
