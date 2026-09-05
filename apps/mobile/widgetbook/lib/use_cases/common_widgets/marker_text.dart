import 'package:ai_sensei/src/common_widgets/marker_text.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// 蛍光マーカー。黄 = 言えたこと、ピンク = 穴。
///
/// **折り返した文で見ること。** 1行ぶんだと、行ごとに引き直している設計
/// (全体を1枚の帯で塗ると下線に見える)が効いているか分からない。
/// 文字サイズのアドオンを上げると行が増えるので、そこで確かめられる。
@widgetbook.UseCase(name: '言えたこと / 穴', type: MarkerText)
Widget buildMarkerTextUseCase(BuildContext context) {
  final MarkerColor marker = context.knobs.object.segmented<MarkerColor>(
    label: '色',
    options: MarkerColor.values,
    labelBuilder: (MarkerColor it) =>
        it == MarkerColor.said ? '言えたこと(黄)' : '穴(ピンク)',
  );

  return stage(
    MarkerText(
      context.knobs.string(
        label: '本文',
        initialValue: '中心と直線の距離dと半径rを比べて位置関係を判定する方針を、理由つきで説明できた',
        maxLines: 3,
      ),
      marker: marker,
    ),
  );
}

/// カルテに並んだ状態。
///
/// 線は**上の行から順に**引かれる([MarkerText.delay] を段差でずらす)。
/// できあがった絵ではなく引かれていく様子が見たいので、
/// 「アニメーションを減らす」を切ると差が出る。
@widgetbook.UseCase(name: 'カルテのように積む', type: MarkerText)
Widget buildMarkerTextStackedUseCase(BuildContext context) {
  const List<String> said = <String>[
    '中心と直線の距離dと半径rを比べて位置関係を判定する方針を、理由つきで説明できた',
    'd < r なら2点で交わる、と対応づけて言えた',
  ];

  return stage(
    Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int i = 0; i < said.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: MarkerText(
              said[i],
              marker: MarkerColor.said,
              delay: AppDurations.stagger * i,
            ),
          ),
        const SizedBox(height: AppSpacing.md),
        const MarkerText(
          '判別式を「なぜ」使うのか、で説明が止まった',
          marker: MarkerColor.hole,
          delay: AppDurations.draw,
        ),
      ],
    ),
  );
}
