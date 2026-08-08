import 'package:ai_sensei/main.dart';
import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/common_widgets/kohai_face.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/settings/application/language_controller.dart';
import 'package:ai_sensei/src/features/settings/presentation/settings_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/harness.dart';

/// 日本語と英語の2ロケール。
///
/// 見ているのは訳の出来ではなく、**日本語が海外のユーザーに出ないこと**と、
/// 画面に出る単元名がサーバ(カリキュラム)の言語のまま素通しされること。
void main() {
  // SharedPreferences のモックを差し込むために要る(`test()` からも触るので main で)。
  TestWidgetsFlutterBinding.ensureInitialized();

  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  group('端末の言語の解決', () {
    // Flutter の既定は「一致しなければ supportedLocales の先頭」。
    // 何もしないとスペイン語の端末に日本語が出る。
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

  // 端末の言語に従うだけでは足りない。端末を日本語のまま英語で説明したい人
  // (その逆も)がいるので、アプリの中で選べることそのものが機能になる。
  group('言語の設定', () {
    test('保存されていなければ端末に合わせる', () {
      expect(AppLanguage.fromCode(null), AppLanguage.system);
      // 端末に合わせるは locale を持たない = Flutter 側の解決に任せる印。
      expect(AppLanguage.system.locale, isNull);
    });

    test('知らない値が保存されていても、落ちずに端末に合わせるへ戻る', () {
      expect(AppLanguage.fromCode('ja'), AppLanguage.japanese);
      expect(AppLanguage.fromCode('en'), AppLanguage.english);
      expect(AppLanguage.fromCode('fr'), AppLanguage.system);
      expect(AppLanguage.fromCode(''), AppLanguage.system);
    });

    test('選んだ言語は、次の起動でも残る', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences preferences = await SharedPreferences.getInstance();

      // 同じ保存領域から立ち上げ直す。1回目と2回目でコンテナを分けるのが
      // 「アプリを起動し直す」に当たる。
      ProviderContainer boot() {
        final List<Object?> overrides = <Object?>[
          preferencesProvider.overrideWithValue(preferences),
        ];
        final ProviderContainer container = ProviderContainer(overrides: overrides.cast());
        addTearDown(container.dispose);
        return container;
      }

      final ProviderContainer first = boot();
      expect(first.read(languageControllerProvider), AppLanguage.system);

      await first.read(languageControllerProvider.notifier).select(AppLanguage.english);
      expect(first.read(languageControllerProvider), AppLanguage.english);

      expect(boot().read(languageControllerProvider), AppLanguage.english);
    });

    // これがこの機能そのもの: **端末は日本語のまま、アプリだけ英語にする**。
    testWidgets('日本語の端末でも、設定で English を選べる', (WidgetTester tester) async {
      reduceMotionOnDevice(tester);
      useDeviceLocale(tester, const Locale('ja', 'JP'));

      await tester.pumpWidget(
        ProviderScope(
          overrides: <Object?>[
            onboardedProvider.overrideWithValue(true),
            deviceIdProvider.overrideWithValue('dev_test'),
            await preferencesOverride(),
            progressControllerProvider.overrideWith(FakeProgressController.new),
          ].cast(),
          // 本物のアプリごと組む。`main()` の配線(設定 → MaterialApp.locale)が
          // 切れていたら、選んでも画面の言葉が変わらない。
          child: const AiSenseiApp(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(Icons.settings_outlined));
      await tester.pumpAndSettle();
      expect(find.text(ja.settingsTitle), findsOneWidget);

      // 言語名は、その言語自身の表記で出す(英語しか読めない人が探せるように)。
      expect(find.text('English'), findsOneWidget);
      expect(find.text('日本語'), findsOneWidget);
      expect(find.text(ja.settingsLanguageSystem), findsOneWidget);

      await tester.tap(find.text('English'));
      await tester.pumpAndSettle();

      expect(find.text(en.settingsTitle), findsOneWidget);
      expect(find.text(ja.settingsTitle), findsNothing);

      // セッションを作るときサーバへ送る `locale` はここから取っている。
      // 画面の文言だけでなく、後輩の言葉と単元の課程もこれで決まる(ADR 0005)。
      expect(
        Localizations.localeOf(tester.element(find.byType(SettingsScreen))).languageCode,
        'en',
      );

      // 開いたままだった画面(ホーム)も、戻ると英語になっている。
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text(en.homeGreeting), findsOneWidget);
    });

    testWidgets('英語の端末でも、日本語を選び直せる', (WidgetTester tester) async {
      await tester.pumpWidget(
        wrapApp(
          const SettingsScreen(),
          locale: const Locale('en'),
          overrides: <Object?>[
            deviceIdProvider.overrideWithValue('dev_test'),
            await preferencesOverride(),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text(en.settingsSectionLanguage), findsOneWidget);
      await tester.tap(find.text('日本語'));
      await tester.pumpAndSettle();

      final ProviderContainer container = ProviderScope.containerOf(
        tester.element(find.byType(SettingsScreen)),
      );
      expect(container.read(languageControllerProvider), AppLanguage.japanese);
    });
  });

  group('読み上げのラベル', () {
    testWidgets('後輩の表情のラベルもロケールに従う', (WidgetTester tester) async {
      await tester.pumpWidget(
        wrapApp(
          const Scaffold(body: KohaiFace(mood: KohaiMood.delighted)),
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel(en.kohaiDelighted), findsOneWidget);
      expect(find.bySemanticsLabel(ja.kohaiDelighted), findsNothing);
    });
  });

  group('カルテ画面(英語)', () {
    // 単元名はサーバのカリキュラムが持っている。海外の課程で始めた
    // セッションなら "Algebra 1 / ..." が返り、アプリはそれをそのまま出す。
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
