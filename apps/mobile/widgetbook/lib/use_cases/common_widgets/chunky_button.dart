import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 触感が主役の部品なので、**押してみられる**ことに意味がある。
/// 沈み込み(`AppElevation.chunkyDepth`)は静止画では見えない。
@widgetbook.UseCase(name: '既定(青)', type: ChunkyButton)
Widget buildChunkyButtonUseCase(BuildContext context) {
  return stage(
    ChunkyButton(
      label: context.knobs.string(label: 'ラベル', initialValue: '授業をはじめる'),
      expanded: context.knobs.boolean(label: '幅いっぱい', initialValue: true),
      onPressed: context.knobs.boolean(label: '押せる', initialValue: true)
          ? () {}
          : null,
    ),
  );
}

/// 押せない状態。**隠さずに、沈まないだけ**にしてある。
/// 色が [AppColors.border] に落ち、影が消えることを目で確かめる。
@widgetbook.UseCase(name: '押せない', type: ChunkyButton)
Widget buildChunkyButtonDisabledUseCase(BuildContext context) {
  return stage(
    const ChunkyButton(label: '授業をはじめる', onPressed: null),
  );
}

/// 祝福の色。連続日数と同じ橙を使う場面(`AppColors.streak`)。
@widgetbook.UseCase(name: '祝福(橙)', type: ChunkyButton)
Widget buildChunkyButtonStreakUseCase(BuildContext context) {
  return stage(
    ChunkyButton(
      label: 'カルテを見る',
      color: AppColors.streak,
      onPressed: () {},
    ),
  );
}

/// 「選んでも損しない選択肢」。目立たせないが、隠さない。
/// **青いボタンの隣に置いたときの目立たなさ**が見るところなので、並べてある。
@widgetbook.UseCase(name: '厚いボタンと並べたとき', type: GhostButton)
Widget buildGhostButtonUseCase(BuildContext context) {
  return stage(
    Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        ChunkyButton(label: 'プレミアムにする', onPressed: () {}),
        const SizedBox(height: AppSpacing.sm),
        GhostButton(label: '無料のまま続ける', onPressed: () {}),
      ],
    ),
  );
}
