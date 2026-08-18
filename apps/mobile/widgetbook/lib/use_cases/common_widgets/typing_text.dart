import 'package:ai_sensei/src/common_widgets/typing_text.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 先輩のせりふ。1文字ずつ出る。
///
/// **高さは最初から最終行ぶんを確保している。** 行が増えるたびに下の
/// ボタンが動くと、読んでいる最中に画面が揺れるため。長い文に変えて、
/// 打ち始めの時点で下端が動かないことを見る。
@widgetbook.UseCase(name: '打っていく', type: TypingText)
Widget buildTypingTextUseCase(BuildContext context) {
  final String text = context.knobs.string(
    label: 'せりふ',
    initialValue: 'じゃあ、いまの考え方をそのまま言葉にしてみて。式は見なくていいよ。',
    maxLines: 3,
  );

  return stage(
    // 打ち直しを見たいので、本文が変わったら State ごと作り直す。
    TypingText(text, key: ValueKey<String>(text)),
  );
}
