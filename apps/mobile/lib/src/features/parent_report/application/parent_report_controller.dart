import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../domain/parent_report.dart';

part 'parent_report_controller.g.dart';

/// 今月の親レポート。
///
/// Premium判定はサーバが正で、無料なら例外ではなくロック状態が返る。
/// クライアントのRevenueCat状態だけで本文を開くと、webhook反映前後でAPIとの
/// 有料境界がずれるので、画面はこの応答だけを見る。
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
