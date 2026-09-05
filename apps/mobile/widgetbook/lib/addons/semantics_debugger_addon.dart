import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';

/// 読み上げの当たり判定を重ねて見せる。
///
/// 板書は `Math.tex` が記号ごとにウィジェットを積むので、包まないと
/// 「エックス」「ハット」「2」…と**バラバラに読まれる**。そこで断片を
/// `ExcludeSemantics` で消し、代わりに1文を置いてある
/// (`board_element_view.dart`)。**崩れても画面の見た目は変わらない**ので、
/// 重ねて見る以外に気づく方法がない。
///
/// Flutter 本体の [SemanticsDebugger] を使う。widgetbook にも
/// `SemanticsAddon` があるが `@experimental` で、`flutter analyze` が
/// 警告を出す(= CIが赤くなる)。同じことが本体のウィジェットでできる。
class SemanticsDebuggerAddon extends WidgetbookAddon<bool> {
  SemanticsDebuggerAddon() : super(name: 'Semantics');

  @override
  List<Field<dynamic>> get fields => <Field<dynamic>>[
    BooleanField(name: 'enabled', initialValue: false),
  ];

  @override
  bool valueFromQueryGroup(Map<String, String> group) =>
      valueOf<bool>('enabled', group) ?? false;

  @override
  Widget buildUseCase(BuildContext context, Widget child, bool setting) {
    // 入れっぱなしにはしない。[SemanticsDebugger] はタップを横取りして
    // 読み上げの探索に使うので、ふだんの操作(ボタンの沈み込みなど)が
    // 確かめられなくなる。
    if (!setting) return child;
    return SemanticsDebugger(child: child);
  }
}
