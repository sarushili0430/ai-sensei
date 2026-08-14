import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../domain/parent_report.dart';

part 'parent_report_controller.g.dart';

/// This month's parent report.
///
/// The server owns the Premium verdict and returns a locked state, not an
/// error, for free users. Unlocking from the client's RevenueCat state alone
/// would drift from the API's boundary around webhook delivery, so the screen
/// trusts only this response.
@riverpod
class ParentReportController extends _$ParentReportController {
  @override
  Future<ParentReportResponse> build() =>
      ref.read(apiClientProvider).fetchParentReport();

  Future<void> refresh() async {
    state = const AsyncValue<ParentReportResponse>.loading();
    state = await AsyncValue.guard(
      () => ref.read(apiClientProvider).fetchParentReport(),
    );
  }
}
