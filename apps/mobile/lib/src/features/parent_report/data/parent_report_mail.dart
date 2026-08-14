import '../../../l10n/strings.dart';
import '../domain/parent_report.dart';

/// The text shown on screen and handed to the mail body unchanged.
///
/// Building the UI and share text separately would let a quote reach the
/// email without ever appearing on screen. Rendering this exact return value
/// keeps the student reviewing what they send before the mail app opens.
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

/// A mail draft with no recipient.
///
/// The parent's address is stored neither on the server nor on the device.
/// Tapping never sends: the student picks the recipient in the mail app and
/// takes the final send action, keeping the spread of their learning record
/// in their own hands — unlike a public URL.
Uri buildParentReportMail({required String subject, required String body}) {
  return Uri(
    scheme: 'mailto',
    queryParameters: <String, String>{'subject': subject, 'body': body},
  );
}
