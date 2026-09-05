import 'package:ai_sensei/src/brand/app_mark.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import '../../support/stage.dart';

/// アプリのマーク。アイコン書き出し(`tool/generate_app_icon.dart`)と
/// **同じ描画コード**なので、ここで崩れて見えるならアイコンも崩れている。
@widgetbook.UseCase(name: '肌を選ぶ', type: AppMarkView)
Widget buildAppMarkUseCase(BuildContext context) {
  final _Skin skin = context.knobs.object.dropdown<_Skin>(
    label: '肌',
    options: _skins,
    labelBuilder: (_Skin it) => it.label,
  );

  return ColoredBox(
    // 透過の肌(iOSのダーク・ティント、Androidのテーマアイコン)は、
    // **システムが敷く地の上**に乗る。白地に置くと出ているかどうかも分からない。
    color: skin.backdrop,
    child: stage(
      AppMarkView(
        skin: skin.data,
        size: context.knobs.double.slider(
          label: '大きさ',
          initialValue: 128,
          min: 48,
          max: 256,
          divisions: 8,
        ),
      ),
    ),
  );
}

class _Skin {
  const _Skin(this.label, this.data, this.backdrop);

  final String label;
  final AppMarkSkin data;

  /// 透過の肌を見るために敷く地。
  final Color backdrop;
}

const List<_Skin> _skins = <_Skin>[
  _Skin('通常', AppMarkSkin.standard, AppColors.background),
  _Skin('iOS ダーク(背景は透過)', AppMarkSkin.dark, Color(0xFF1C1C1E)),
  _Skin('iOS ティント(輝度から色を作る)', AppMarkSkin.tinted, Color(0xFF3A3A3C)),
  _Skin('Android 前景', AppMarkSkin.adaptiveForeground, AppColors.blue),
  _Skin('Android テーマアイコン', AppMarkSkin.monochrome, Color(0xFF3A3A3C)),
];
