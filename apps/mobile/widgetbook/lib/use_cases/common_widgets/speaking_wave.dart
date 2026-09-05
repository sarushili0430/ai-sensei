import 'package:ai_sensei/src/common_widgets/speaking_wave.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 「聞いています」の波形。**本物の音量には連動していない。**
///
/// 止めているときも消えないこと(マイクの置き場所を保つため、低いまま並ぶ)を
/// 見るのがここ。`active` を切り替えて、消えずに沈むことを確かめる。
@widgetbook.UseCase(name: '聞いている / 聞いていない', type: SpeakingWave)
Widget buildSpeakingWaveUseCase(BuildContext context) {
  return stage(
    SpeakingWave(
      active: context.knobs.boolean(label: '聞いている', initialValue: true),
      bars: context.knobs.int.slider(
        label: '本数',
        initialValue: 5,
        min: 3,
        max: 9,
        divisions: 6,
      ),
      height: context.knobs.double.slider(
        label: '高さ',
        initialValue: 26,
        min: 12,
        max: 64,
        divisions: 4,
      ),
      color: context.knobs.boolean(label: '穴の色で出す') ? AppColors.hole : AppColors.blue,
    ),
  );
}
