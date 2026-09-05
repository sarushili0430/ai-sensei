import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';

/// 「アニメーションを減らす」を切り替えるアドオン。
///
/// このアプリの部品は、ほぼ全部が `AppMotion.isReduced` で枝分かれしている
/// (`lib/src/theme/motion.dart`)。減らす設定のときは**途中で止めず、終わった
/// 状態を描く**という約束があるので、切り替えられないカタログだと、
/// 実装の半分を一度も見ないまま「見た目を確認した」ことになってしまう。
///
/// 入口は端末の設定と同じ [MediaQueryData.disableAnimations]。
/// widget test の足場(`test/support/harness.dart` の `reduceMotion`)と
/// 同じ経路なので、**golden が撮っているのはこのスイッチを入れた側**になる。
class ReduceMotionAddon extends WidgetbookAddon<bool> {
  ReduceMotionAddon({this.initialValue = false}) : super(name: 'Reduce motion');

  /// 既定は「動かす」。まず本来の見え方が出てほしいので、
  /// 止めた状態を初期値にはしない。
  final bool initialValue;

  @override
  List<Field<dynamic>> get fields => <Field<dynamic>>[
    BooleanField(name: 'enabled', initialValue: initialValue),
  ];

  @override
  bool valueFromQueryGroup(Map<String, String> group) =>
      valueOf<bool>('enabled', group) ?? initialValue;

  @override
  Widget buildUseCase(BuildContext context, Widget child, bool setting) {
    // ここより外側(viewport のアドオン)が組み立てた MediaQuery を引き継ぐ。
    // 上書きするのは1項目だけ。
    return MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: setting),
      child: child,
    );
  }
}
