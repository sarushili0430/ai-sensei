import 'package:ai_sensei/src/common_widgets/confetti.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

/// 祝福の紙吹雪。
///
/// **画面いっぱいに降るもの**なので、余白を付けずに置いてある。
/// 端末の寸法(アドオン)を切り替えて、降り方が縦横比に耐えるかを見る。
@widgetbook.UseCase(name: '降らせる', type: ConfettiBurst)
Widget buildConfettiBurstUseCase(BuildContext context) {
  final int pieces = context.knobs.int.slider(
    label: '枚数',
    initialValue: 26,
    min: 4,
    max: 80,
    divisions: 19,
  );
  final bool looping = context.knobs.boolean(label: '繰り返す');

  return ColoredBox(
    // 祝福画面の地。透過ではなく**混ぜて不透明にした色**を使う
    // (`AppColors.celebration` の説明を参照。透過のまま敷くと、
    // 遷移が終わった瞬間に画面が真っ黒に沈む)。
    color: AppColors.celebration,
    child: ConfettiBurst(
      key: ValueKey<String>('$pieces/$looping'),
      pieces: pieces,
      looping: looping,
    ),
  );
}
