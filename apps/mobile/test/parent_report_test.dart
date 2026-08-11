import 'package:ai_sensei/src/features/parent_report/application/parent_report_controller.dart';
import 'package:ai_sensei/src/features/parent_report/data/parent_report_mail.dart';
import 'package:ai_sensei/src/features/parent_report/domain/parent_report.dart';
import 'package:ai_sensei/src/features/parent_report/presentation/parent_report_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

void main() {
  test('メール下書きの本文は、画面に見せる本文と1文字も変えない', () {
    const AppStrings strings = AppStrings(Locale('ja'));
    final ParentReport report = sampleParentReportResponse.report!;
    final String visibleText = buildParentReportText(report, strings);
    final Uri mail = buildParentReportMail(
      subject: strings.parentReportMailSubject,
      body: visibleText,
    );

    expect(mail.scheme, 'mailto');
    expect(mail.path, isEmpty, reason: '親の宛先をアプリ側で決めない');
    expect(mail.queryParameters['body'], visibleText);
    expect(visibleText, contains(report.quotes.first));
    expect(visibleText, contains(strings.paywallPrice));
    expect(mail.toString(), isNot(contains('http')), reason: '公開URLを共有しない');
  });

  test('親レポートの料金文言はペイウォールと同じ価格を使う(日英)', () {
    for (final Locale locale in const <Locale>[Locale('ja'), Locale('en')]) {
      final AppStrings strings = AppStrings(locale);
      expect(strings.parentReportPriceNote, contains(strings.paywallPrice));
    }
  });

  test('共有本文にスコア・正答率・順位を作らない', () {
    const AppStrings strings = AppStrings(Locale('ja'));
    final String text = buildParentReportText(
      sampleParentReportResponse.report!,
      strings,
    );

    for (final String forbidden in <String>[
      '正答率',
      '理解度',
      '偏差値',
      'ランキング',
      '順位',
    ]) {
      expect(text, isNot(contains(forbidden)));
    }
  });

  testWidgets('共有される本文と本人の引用を、ボタンより前に全部見せる', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const ParentReportScreen(),
      overrides: <Object?>[
        parentReportControllerProvider.overrideWith(
          () => FakeParentReportController(sampleParentReportResponse),
        ),
      ],
    );

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(ParentReportScreen)),
    );
    final String visibleText = buildParentReportText(
      sampleParentReportResponse.report!,
      strings,
    );
    expect(find.text(visibleText), findsOneWidget);
    expect(find.text(strings.parentReportSendEmail), findsOneWidget);
    expect(find.text(strings.parentReportPreviewNote), findsOneWidget);
    for (final String quote in sampleParentReportResponse.report!.quotes) {
      expect(visibleText, contains(quote));
    }
  });

  testWidgets('無料ユーザーはエラーではなく、まだ開いていない状態を見る', (WidgetTester tester) async {
    await pumpApp(
      tester,
      const ParentReportScreen(),
      overrides: <Object?>[
        parentReportControllerProvider.overrideWith(
          () => FakeParentReportController(ParentReportResponse.locked),
        ),
      ],
    );

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(ParentReportScreen)),
    );
    expect(find.textContaining(strings.parentReportLocked), findsOneWidget);
    expect(find.text(strings.paywallCta), findsOneWidget);
    expect(find.text(strings.parentReportSendEmail), findsNothing);
  });
}
