import 'package:ai_sensei/src/common_widgets/senpai_face.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 表情を1つずつ。**呼吸とまばたきが止まらないこと**が正しい状態なので、
/// 「アニメーションを減らす」を切って見ること(入れると止まる)。
@widgetbook.UseCase(name: '表情を選ぶ', type: SenpaiFace)
Widget buildSenpaiFaceUseCase(BuildContext context) {
  return stage(
    SenpaiFace(
      mood: context.knobs.object.dropdown<SenpaiMood>(
        label: '表情',
        options: SenpaiMood.values,
        labelBuilder: _moodLabel,
      ),
      size: context.knobs.double.slider(
        label: '大きさ',
        initialValue: 120,
        min: 48,
        max: 240,
        divisions: 8,
      ),
    ),
  );
}

/// 4つを並べる。
///
/// ここで見たいのは**[SenpaiMood.puzzled] を出す場面を間違えていないか**。
/// 困っているのは先輩のほうで、生徒が詰まったときの顔ではない
/// (詰まったのは織り込み済みなので、そこは [SenpaiMood.neutral] のまま受け取る)。
/// 並べると「生徒に向ける顔」に見えてしまいがちなので、
/// ラベルに意味を書いてある。
@widgetbook.UseCase(name: '4つ並べる', type: SenpaiFace)
Widget buildSenpaiFaceAllUseCase(BuildContext context) {
  return stage(
    Wrap(
      spacing: AppSpacing.lg,
      runSpacing: AppSpacing.lg,
      alignment: WrapAlignment.center,
      children: <Widget>[
        for (final SenpaiMood mood in SenpaiMood.values)
          Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              SenpaiFace(mood: mood, size: 96),
              const SizedBox(height: AppSpacing.xs),
              Text(_moodLabel(mood), style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
      ],
    ),
  );
}

String _moodLabel(SenpaiMood mood) => switch (mood) {
  SenpaiMood.neutral => '待機 / ただ受け取った',
  SenpaiMood.listening => '聞いている',
  SenpaiMood.delighted => 'そう、それ',
  SenpaiMood.puzzled => 'こちら側の不首尾',
};
