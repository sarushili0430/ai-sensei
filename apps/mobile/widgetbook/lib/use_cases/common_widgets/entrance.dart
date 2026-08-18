import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/common_widgets/entrance.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 段差(stagger)。**読んでほしい順**に上から現れる。
///
/// 同時に出すと読む順序が消えるので、[FadeSlideIn.staggered] の `index` を
/// ずらす。並びに意味が無いもの(カードのグリッドなど)には使わない部品。
///
/// 「アニメーションを減らす」を入れると、**途中で止まらず終わった状態**で
/// 出る(0で止めると本文が薄いまま消えて、壊れて見える)。
@widgetbook.UseCase(name: '段差で入ってくる', type: FadeSlideIn)
Widget buildFadeSlideInUseCase(BuildContext context) {
  final int count = context.knobs.int.slider(
    label: '要素の数',
    initialValue: 4,
    min: 1,
    max: 6,
    divisions: 5,
  );

  return stage(
    Column(
      // 再生し直せるように、数を変えたら作り直す。
      key: ValueKey<int>(count),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int i = 0; i < count; i++)
          FadeSlideIn.staggered(
            index: i,
            child: Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Text('${i + 1}行目', style: Theme.of(context).textTheme.bodyLarge),
            ),
          ),
      ],
    ),
  );
}

/// 跳ねて出てくる。**にぎやかな画面だけ**が使える動き
/// (カルテと復習に持ち込むと、記録が軽く見える)。
@widgetbook.UseCase(name: '跳ねて出てくる', type: PopIn)
Widget buildPopInUseCase(BuildContext context) {
  final bool key = context.knobs.boolean(label: '再生し直す');

  return stage(
    PopIn(
      key: ValueKey<bool>(key),
      child: ChunkyButton(label: 'やった!', color: AppColors.streak, onPressed: () {}),
    ),
  );
}

/// 数え上げ。**数えているのが連続日数と埋めた穴だけ**だから、増えたことを見せる。
/// 正誤や点数には使わない(そもそも出さない)。
@widgetbook.UseCase(name: '数え上げる', type: CountUpText)
Widget buildCountUpTextUseCase(BuildContext context) {
  final int value = context.knobs.int.slider(
    label: '数',
    initialValue: 3,
    min: 0,
    max: 30,
    divisions: 30,
  );

  return stage(
    CountUpText(
      value,
      key: ValueKey<int>(value),
      style: Theme.of(context).textTheme.displaySmall?.copyWith(color: AppColors.streak),
    ),
  );
}
