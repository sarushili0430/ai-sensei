import '../../../l10n/strings.dart';
import '../domain/parent_report.dart';

/// 画面に見せ、そのままメール本文へ渡すテキスト。
///
/// UI用と共有用を別々に組み立てると、画面には無い引用がメールにだけ混ざる余地ができる。
/// **この返り値を画面にも全文表示する**ことで、本人が送る内容を確認してから
/// メールアプリへ進める形を保つ。
String buildParentReportText(
  ParentReport report,
  AppStrings strings, {
  String? plan,
  String? price,
}) {
  final List<String> lines = <String>[
    strings.parentReportTitle,
    strings.parentReportPeriod(
      strings.date(report.period.startDate),
      strings.date(report.period.endDate),
    ),
    '',
    strings.parentReportFilledLine(report.filledHoles),
    strings.parentReportStreakLine(report.streakDays),
    '',
    strings.parentReportTopicsTitle,
    if (report.explainedTopics.isEmpty)
      strings.parentReportTopicsEmpty
    else
      for (final ParentReportTopic topic in report.explainedTopics)
        '・${topic.name}',
    '',
    strings.parentReportQuotesTitle,
    if (report.quotes.isEmpty)
      strings.parentReportQuotesEmpty
    else
      for (final String quote in report.quotes)
        strings.parentReportQuote(quote),
    '',
    strings.parentReportPriceNote(plan: plan, price: price),
  ];
  return lines.join('\n');
}

/// 宛先を空にしたメール下書き。
///
/// 親のメールアドレスをサーバにも端末にも保存しない。ボタンを押しても送信はされず、
/// 本人がメールアプリで宛先を選び、最後の送信操作をする。公開URLを作るよりも
/// 子どもの理解の記録が広がる範囲を本人の操作に閉じられる。
Uri buildParentReportMail({required String subject, required String body}) {
  return Uri(
    scheme: 'mailto',
    queryParameters: <String, String>{'subject': subject, 'body': body},
  );
}
